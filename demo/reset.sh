#!/bin/sh
set -eu
curl -fsS -X POST http://127.0.0.1:${PORT:-4173}/api/reset >/dev/null
printf '演示数据和界面状态已重置\n'
