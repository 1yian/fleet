import atexit
import os
import shutil
from pathlib import Path


def work_dir() -> Path:
    path = Path(os.environ.get("HOME", "/tmp")) / "solver-work" / str(os.getpid())
    path.mkdir(parents=True, exist_ok=True)
    atexit.register(shutil.rmtree, path, True)
    return path
