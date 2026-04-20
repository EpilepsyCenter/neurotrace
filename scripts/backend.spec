# PyInstaller spec for the NeuroTrace backend.
#
# Produces a onedir bundle at `backend-dist/` with the executable named `main`.
# This layout is consumed by electron/main.ts: in production it spawns
# `<resources>/backend/main`, and package.json's `extraResources` maps
# `backend-dist/` -> `<resources>/backend/`.

from PyInstaller.utils.hooks import collect_submodules, collect_data_files
from pathlib import Path

PROJECT = Path(SPECPATH).resolve().parent
BACKEND = PROJECT / 'backend'

hidden = []
# uvicorn wires its loops/protocols lazily — PyInstaller can't see them.
hidden += collect_submodules('uvicorn')
# Our own packages are imported via `from api.files import router` etc.
# which means PyInstaller's import graph needs them explicitly, since
# SPECPATH lives outside backend/.
for pkg in ('api', 'analysis', 'readers', 'macros', 'utils'):
    hidden += collect_submodules(pkg)
# Neo and Myokit both load plugins/data files at import time.
hidden += collect_submodules('neo')
hidden += collect_submodules('myokit')

datas = []
datas += collect_data_files('neo')
datas += collect_data_files('myokit')

# The base conda env includes deeplabcut/torch/PyQt/etc. — PyInstaller's
# module-graph pulls them in transitively through optional neo/scipy
# hooks. None are used by NeuroTrace, so drop them aggressively.
EXCLUDES = [
    'tkinter',
    'matplotlib',
    'IPython', 'ipykernel', 'jupyter', 'jupyter_core', 'jupyter_client',
    'notebook', 'nbconvert', 'nbformat',
    'torch', 'torchvision', 'torchaudio',
    'tensorflow', 'keras', 'jax', 'jaxlib',
    'sklearn', 'sympy',
    'pandas',
    'pyarrow',
    'PIL', 'Pillow',
    'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
    'wx', 'tk',
    'pytest', 'sphinx', 'docutils',
    'deeplabcut',
    'cv2',
]

a = Analysis(
    [str(BACKEND / 'main.py')],
    pathex=[str(BACKEND)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=EXCLUDES,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='main',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='backend-dist',
)
