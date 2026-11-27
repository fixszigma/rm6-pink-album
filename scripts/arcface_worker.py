import sys
import os
import json
import base64
import cv2
import numpy as np
import onnxruntime as ort

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT_DIR, "models", "buffalo_l")
DET_PATH = os.path.join(MODEL_DIR, "det_10g.onnx")
REC_PATH = os.path.join(MODEL_DIR, "w600k_r50.onnx")

# Standard 5-point reference landmarks on 112x112 aligned ArcFace input
ARCFACE_DST = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041]
], dtype=np.float32)


class SCRFDDetector:
    def __init__(self, model_path, input_size=(960, 960)):
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        ort_threads = int(os.environ.get("ORT_THREADS", "0") or "0")
        if ort_threads > 0:
            so.intra_op_num_threads = ort_threads
            so.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [o.name for o in self.session.get_outputs()]
        self.input_size = input_size  # (width, height), multiples of 32
        self.feat_strides = [8, 16, 32]
        self.num_anchors = 2
        self._anchor_cache = {}

    def _get_anchor_centers(self, fh, fw, stride):
        key = (fh, fw, stride)
        if key in self._anchor_cache:
            return self._anchor_cache[key]
        ac = np.stack(np.mgrid[:fh, :fw][::-1], axis=-1).astype(np.float32)
        ac = (ac * stride).reshape((-1, 2))
        ac = np.stack([ac] * self.num_anchors, axis=1).reshape((-1, 2))
        self._anchor_cache[key] = ac
        return ac

    @staticmethod
    def _nms(dets, thresh=0.40):
        if len(dets) == 0:
            return []
        x1 = dets[:, 0]
        y1 = dets[:, 1]
        x2 = dets[:, 2]
        y2 = dets[:, 3]
        scores = dets[:, 4]
        areas = (x2 - x1 + 1) * (y2 - y1 + 1)
        order = scores.argsort()[::-1]
        keep = []
        while order.size > 0:
            i = order[0]
            keep.append(i)
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            w = np.maximum(0.0, xx2 - xx1 + 1)
            h = np.maximum(0.0, yy2 - yy1 + 1)
            inter = w * h
            ovr = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
            inds = np.where(ovr <= thresh)[0]
            order = order[inds + 1]
        return keep

    def detect(self, img_bgr, score_thresh=0.45):
        orig_h, orig_w = img_bgr.shape[:2]
        in_w, in_h = self.input_size
        im_ratio = float(orig_h) / float(orig_w)
        model_ratio = float(in_h) / float(in_w)
        if im_ratio > model_ratio:
            new_h = in_h
            new_w = max(1, int(round(new_h / im_ratio)))
        else:
            new_w = in_w
            new_h = max(1, int(round(new_w * im_ratio)))

        det_scale = float(new_h) / float(orig_h)
        resized = cv2.resize(img_bgr, (new_w, new_h))
        det_img = np.zeros((in_h, in_w, 3), dtype=np.uint8)
        det_img[:new_h, :new_w, :] = resized

        blob = cv2.dnn.blobFromImage(
            det_img, 1.0 / 128.0, (in_w, in_h), (127.5, 127.5, 127.5), swapRB=True
        )
        net_outs = self.session.run(self.output_names, {self.input_name: blob})

        fmc = 3
        scores_list = []
        bboxes_list = []
        kpss_list = []

        for idx, stride in enumerate(self.feat_strides):
            scores = net_outs[idx].reshape(-1)
            bbox_preds = net_outs[idx + fmc].reshape(-1, 4) * stride
            kps_preds = net_outs[idx + fmc * 2].reshape(-1, 10) * stride

            fh = in_h // stride
            fw = in_w // stride
            anchor_centers = self._get_anchor_centers(fh, fw, stride)

            pos_inds = np.where(scores >= score_thresh)[0]
            if pos_inds.size == 0:
                continue

            pos_scores = scores[pos_inds]
            pos_ac = anchor_centers[pos_inds]
            pos_bb = bbox_preds[pos_inds]
            pos_kp = kps_preds[pos_inds]

            x1 = pos_ac[:, 0] - pos_bb[:, 0]
            y1 = pos_ac[:, 1] - pos_bb[:, 1]
            x2 = pos_ac[:, 0] + pos_bb[:, 2]
            y2 = pos_ac[:, 1] + pos_bb[:, 3]
            bboxes = np.stack([x1, y1, x2, y2], axis=-1)

            kpss = pos_kp.reshape((-1, 5, 2)) + pos_ac[:, None, :]

            scores_list.append(pos_scores)
            bboxes_list.append(bboxes)
            kpss_list.append(kpss)

        if not scores_list:
            return np.zeros((0, 5), dtype=np.float32), np.zeros((0, 5, 2), dtype=np.float32)

        scores_all = np.concatenate(scores_list, axis=0)
        bboxes_all = np.concatenate(bboxes_list, axis=0) / det_scale
        kpss_all = np.concatenate(kpss_list, axis=0) / det_scale

        # Clip boxes to original image bounds
        bboxes_all[:, [0, 2]] = np.clip(bboxes_all[:, [0, 2]], 0, orig_w)
        bboxes_all[:, [1, 3]] = np.clip(bboxes_all[:, [1, 3]], 0, orig_h)

        pre_det = np.hstack((bboxes_all, scores_all[:, None])).astype(np.float32)
        keep = self._nms(pre_det, thresh=0.40)
        return pre_det[keep], kpss_all[keep]


class ArcFaceRecognizer:
    def __init__(self, model_path):
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        ort_threads = int(os.environ.get("ORT_THREADS", "0") or "0")
        if ort_threads > 0:
            so.intra_op_num_threads = ort_threads
            so.inter_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name

    @staticmethod
    def align_face(img_bgr, kps5):
        M, _ = cv2.estimateAffinePartial2D(kps5.astype(np.float32), ARCFACE_DST, method=cv2.LMEDS)
        if M is None:
            M, _ = cv2.estimateAffinePartial2D(kps5.astype(np.float32), ARCFACE_DST)
        if M is None:
            return None
        return cv2.warpAffine(img_bgr, M, (112, 112), borderValue=0.0)

    def embed_aligned_batch(self, aligned_bgr_list, flip_augment=False):
        if not aligned_bgr_list:
            return np.zeros((0, 512), dtype=np.float32)

        def run_batch(imgs):
            blob = cv2.dnn.blobFromImages(
                imgs, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True
            )
            feats = self.session.run([self.output_name], {self.input_name: blob})[0]
            return feats.astype(np.float32)

        feats = run_batch(aligned_bgr_list)
        if flip_augment:
            flipped = [cv2.flip(im, 1) for im in aligned_bgr_list]
            feats = feats + run_batch(flipped)

        norms = np.linalg.norm(feats, axis=1, keepdims=True) + 1e-12
        return feats / norms


def make_avatar_data_url(img_bgr, x1, y1, x2, y2):
    h, w = img_bgr.shape[:2]
    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)
    pad = max(bw, bh) * 0.28
    cx1 = max(0, int(round(x1 - pad)))
    cy1 = max(0, int(round(y1 - pad)))
    cx2 = min(w, int(round(x2 + pad)))
    cy2 = min(h, int(round(y2 + pad)))
    crop = img_bgr[cy1:max(cy1 + 1, cy2), cx1:max(cx1 + 1, cx2)]
    resized = cv2.resize(crop, (128, 128), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", resized, [int(cv2.IMWRITE_JPEG_QUALITY), 86])
    if not ok:
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def make_thumb_bytes(img_bgr, max_dim=720):
    h, w = img_bgr.shape[:2]
    scale = min(1.0, float(max_dim) / max(w, h, 1))
    tw = max(1, int(round(w * scale)))
    th = max(1, int(round(h * scale)))
    resized = cv2.resize(img_bgr, (tw, th), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", resized, [int(cv2.IMWRITE_JPEG_QUALITY), 84])
    return buf.tobytes() if ok else b""


def load_bgr_from_req(req):
    if req.get("imagePath"):
        p = req["imagePath"]
        if not os.path.exists(p):
            return None
        # Use np.fromfile to support Unicode/Thai Windows file paths reliably
        arr = np.fromfile(p, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if req.get("imageBase64"):
        raw = req["imageBase64"]
        if "," in raw:
            raw = raw.split(",", 1)[1]
        arr = np.frombuffer(base64.b64decode(raw), dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return None


def analyze_single_image(detector, recognizer, img_bgr, score_thresh=0.45, flip_augment=True):
    if img_bgr is None:
        return {"width": 0, "height": 0, "faces": []}

    orig_h, orig_w = img_bgr.shape[:2]
    dets, kpss = detector.detect(img_bgr, score_thresh=score_thresh)
    if len(dets) == 0:
        return {"width": orig_w, "height": orig_h, "faces": []}

    aligned_list = []
    meta_list = []

    for i in range(len(dets)):
        x1, y1, x2, y2, det_score = [float(v) for v in dets[i]]
        bw = x2 - x1
        bh = y2 - y1
        if bw < 22 or bh < 22:
            continue

        aligned = recognizer.align_face(img_bgr, kpss[i])
        if aligned is None:
            continue

        gray_al = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
        blur_var = float(cv2.Laplacian(gray_al, cv2.CV_64F).var())

        # Determine whether this face is sharp/large enough to appear as a prominent person avatar
        # (Smaller/slightly softer faces are STILL indexed so searching finds every photo!)
        min_side = min(bw, bh)
        cluster_eligible = bool(det_score >= 0.60 and min_side >= 42 and blur_var >= 18.0)

        aligned_list.append(aligned)
        meta_list.append({
            "box": {
                "x": int(round(x1)),
                "y": int(round(y1)),
                "width": int(round(bw)),
                "height": int(round(bh))
            },
            "detScore": round(det_score, 4),
            "blurScore": round(blur_var, 2),
            "clusterEligible": cluster_eligible,
            "avatarDataUrl": make_avatar_data_url(img_bgr, x1, y1, x2, y2)
        })

    if not aligned_list:
        return {"width": orig_w, "height": orig_h, "faces": []}

    embeddings = recognizer.embed_aligned_batch(aligned_list, flip_augment=flip_augment)

    # Sort faces largest/most prominent first (helpful when picking primary face in a selfie)
    order = sorted(
        range(len(meta_list)),
        key=lambda idx: meta_list[idx]["box"]["width"] * meta_list[idx]["box"]["height"],
        reverse=True
    )

    faces_out = []
    for idx in order:
        m = meta_list[idx]
        m["descriptor"] = [round(float(v), 6) for v in embeddings[idx]]
        faces_out.append(m)

    return {
        "width": orig_w,
        "height": orig_h,
        "faces": faces_out
    }


def main():
    if not (os.path.exists(DET_PATH) and os.path.exists(REC_PATH)):
        sys.stderr.write(f"Missing InsightFace models in {MODEL_DIR}\n")
        sys.exit(2)

    detector = SCRFDDetector(DET_PATH, input_size=(960, 960))
    recognizer = ArcFaceRecognizer(REC_PATH)

    # Signal ready on first line
    sys.stdout.write(json.dumps({"ready": True, "model": "buffalo_l (SCRFD-10G + ArcFace-R50 512-D)"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd", "analyze")

            if cmd == "ping":
                resp = {"id": req_id, "ok": True}
            elif cmd == "analyze":
                img_bgr = load_bgr_from_req(req)
                res = analyze_single_image(
                    detector,
                    recognizer,
                    img_bgr,
                    score_thresh=float(req.get("scoreThresh", 0.45)),
                    flip_augment=bool(req.get("flipAugment", True))
                )
                if req.get("saveThumbPath") and img_bgr is not None:
                    tb = make_thumb_bytes(img_bgr, max_dim=720)
                    if tb:
                        with open(req["saveThumbPath"], "wb") as tf:
                            tf.write(tb)
                if req.get("savePreviewPath") and img_bgr is not None:
                    pb = make_thumb_bytes(img_bgr, max_dim=1600)
                    if pb:
                        with open(req["savePreviewPath"], "wb") as pf:
                            pf.write(pb)
                resp = {"id": req_id, "ok": True, **res}
            elif cmd == "make_preview":
                img_bgr = load_bgr_from_req(req)
                if img_bgr is None:
                    resp = {"id": req_id, "ok": False, "error": "Cannot decode image"}
                else:
                    if req.get("saveThumbPath"):
                        tb = make_thumb_bytes(img_bgr, max_dim=720)
                        if tb:
                            with open(req["saveThumbPath"], "wb") as tf:
                                tf.write(tb)
                    if req.get("savePreviewPath"):
                        pb = make_thumb_bytes(img_bgr, max_dim=1600)
                        if pb:
                            with open(req["savePreviewPath"], "wb") as pf:
                                pf.write(pb)
                    h, w = img_bgr.shape[:2]
                    resp = {"id": req_id, "ok": True, "width": w, "height": h}
            elif cmd == "batch_paths":
                items = req.get("items", [])
                results = {}
                for it in items:
                    pid = it["id"]
                    img_bgr = load_bgr_from_req({"imagePath": it["imagePath"]})
                    res = analyze_single_image(detector, recognizer, img_bgr, score_thresh=0.45, flip_augment=True)
                    if it.get("saveThumbPath") and img_bgr is not None:
                        tb = make_thumb_bytes(img_bgr, max_dim=720)
                        if tb:
                            with open(it["saveThumbPath"], "wb") as tf:
                                tf.write(tb)
                    if it.get("savePreviewPath") and img_bgr is not None:
                        pb = make_thumb_bytes(img_bgr, max_dim=1600)
                        if pb:
                            with open(it["savePreviewPath"], "wb") as pf:
                                pf.write(pb)
                    results[pid] = res
                resp = {"id": req_id, "ok": True, "results": results}
            else:
                resp = {"id": req_id, "ok": False, "error": f"Unknown cmd: {cmd}"}
        except Exception as e:
            resp = {"id": req_id, "ok": False, "error": str(e)}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
