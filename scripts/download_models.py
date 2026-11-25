import os
import sys
import urllib.request
import zipfile

MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "buffalo_l")
DET_PATH = os.path.join(MODEL_DIR, "det_10g.onnx")
REC_PATH = os.path.join(MODEL_DIR, "w600k_r50.onnx")

BUFFALO_L_URLS = [
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
    "https://huggingface.co/immich-app/buffalo_l/resolve/main/det_10g.onnx",
]

def download_file(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (RM6PinkAlbum/2.0)"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)

def ensure_models():
    os.makedirs(MODEL_DIR, exist_ok=True)
    if os.path.exists(DET_PATH) and os.path.exists(REC_PATH):
        print("Models already present:", DET_PATH, REC_PATH)
        return

    zip_path = os.path.join(MODEL_DIR, "buffalo_l.zip")
    try:
        print("Downloading InsightFace buffalo_l.zip from GitHub release...")
        download_file("https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip", zip_path)
        print("Extracting det_10g.onnx and w600k_r50.onnx...")
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.namelist():
                base = os.path.basename(member)
                if base in ("det_10g.onnx", "w600k_r50.onnx"):
                    with zf.open(member) as src, open(os.path.join(MODEL_DIR, base), "wb") as dst:
                        dst.write(src.read())
        os.remove(zip_path)
    except Exception as e:
        print("GitHub zip fallback to HuggingFace mirrors:", e)
        if os.path.exists(zip_path):
            os.remove(zip_path)
        if not os.path.exists(DET_PATH):
            download_file("https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/buffalo_l/det_10g.onnx", DET_PATH)
        if not os.path.exists(REC_PATH):
            download_file("https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/buffalo_l/w600k_r50.onnx", REC_PATH)

    if not (os.path.exists(DET_PATH) and os.path.exists(REC_PATH)):
        raise RuntimeError("Failed to download InsightFace ONNX models")

    print(f"Ready: det_10g.onnx ({os.path.getsize(DET_PATH)//1024//1024} MB), w600k_r50.onnx ({os.path.getsize(REC_PATH)//1024//1024} MB)")

if __name__ == "__main__":
    ensure_models()
