#!/usr/bin/env bash
# Freeze the Python backend with PyInstaller for distribution.
# Output lands in backend-dist/ (consumed by electron-builder's extraResources).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Cleaning previous build artifacts"
rm -rf backend-dist build/pyi-dist build/pyi-work

echo "==> Running PyInstaller"
python3 -m PyInstaller \
  --noconfirm \
  --distpath=build/pyi-dist \
  --workpath=build/pyi-work \
  scripts/backend.spec

# PyInstaller emits build/pyi-dist/backend-dist/ — move it to the root
# so electron-builder's extraResources picks it up as ./backend-dist.
mv build/pyi-dist/backend-dist backend-dist

SIZE=$(du -sh backend-dist | awk '{print $1}')
echo "==> Backend frozen to $PROJECT_DIR/backend-dist/ ($SIZE)"

# Linux: some transitively-bundled native libs (inside numpy / scipy
# etc.) have DT_NEEDED against the *unversioned* `libz.so` name.
# PyInstaller ships only `libz.so.1`, so the runtime linker can't
# resolve it on hosts without `zlib1g-dev` (= the dev package that
# creates the unversioned symlink). Create it ourselves so the
# AppImage is self-sufficient. Same pattern for other common
# unversioned-name leaks (libssl, libcrypto) as a defensive measure.
if [ "$(uname)" = "Linux" ]; then
  echo "==> Linux: patching bundled .so symlinks"
  cd backend-dist
  for libbase in libz libssl libcrypto libstdc++; do
    # Find the first matching versioned file (e.g. libz.so.1, libz.so.1.2.13).
    first_ver=$(ls "${libbase}.so."* 2>/dev/null | head -n 1 || true)
    if [ -n "$first_ver" ] && [ ! -e "${libbase}.so" ]; then
      ln -s "$first_ver" "${libbase}.so"
      echo "    linked ${libbase}.so -> $first_ver"
    fi
  done
  cd ..
fi

echo "==> Smoke test: starting bundled backend on port 18765"
./backend-dist/main --port 18765 >/tmp/nt-backend-smoke.log 2>&1 &
PID=$!
ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 2
  if curl -fsS http://127.0.0.1:18765/health >/dev/null 2>&1; then
    echo "==> Health check OK after $((i * 2))s"
    ok=1
    break
  fi
done
kill "$PID" 2>/dev/null || true
wait 2>/dev/null || true
if [ "$ok" -ne 1 ]; then
  echo "==> Health check FAILED — log:" >&2
  cat /tmp/nt-backend-smoke.log >&2
  exit 1
fi
