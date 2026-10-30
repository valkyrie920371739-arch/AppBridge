#!/bin/zsh
set -euo pipefail
appbridge_workspace="${HOME}/Library/Application Support/AppBridge"
if [[ ! -d "${appbridge_workspace}" ]]; then
  print "请先运行 AppBridge，初始化工作区。"
  exit 1
fi
/usr/bin/open "${appbridge_workspace}"
