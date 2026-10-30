#!/bin/zsh
set -euo pipefail

script_directory="${0:A:h}"
source_app="${script_directory}/AppBridge.app"
applications_directory="${HOME}/Applications"
installed_app="${applications_directory}/AppBridge.app"

if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/bin/uname -m)" != "arm64" ]]; then
  print "此安装包需要使用 Apple 芯片的 Mac。"
  exit 1
fi
if [[ ! -d "${source_app}" ]]; then
  print "请先完整解压，再从应用旁边运行这个安装文件。"
  exit 1
fi
if [[ -e "${installed_app}" ]]; then
  print "${installed_app} 已存在。为避免覆盖，请先在访达中移动旧版本，再重新运行。"
  exit 1
fi

/bin/mkdir -p "${applications_directory}"
staging_directory="$(/usr/bin/mktemp -d "${applications_directory}/.appbridge.XXXXXXXX")"
staged_app="${staging_directory}/AppBridge.app"
/usr/bin/ditto "${source_app}" "${staged_app}"

print "正在为本机准备应用。这一步只处理刚复制的 AppBridge.app。"
/usr/bin/xattr -dr com.apple.quarantine "${staged_app}" 2>/dev/null || true
/usr/bin/codesign --force --deep --sign - --preserve-metadata=entitlements "${staged_app}"
/usr/bin/codesign --verify --deep --strict "${staged_app}"
/bin/mv "${staged_app}" "${installed_app}"
/bin/rmdir "${staging_directory}"
/usr/bin/open "${installed_app}"
print "应用已安装到：${installed_app}"
