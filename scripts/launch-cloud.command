#!/bin/zsh
set -euo pipefail
appbridge_cloud_directory="${0:A:h}"
appbridge_archive="${appbridge_cloud_directory}/AppBridge-Mac-arm64-__VERSION__.zip"
appbridge_digest="__SHA256__"
appbridge_workspace="${HOME}/Library/Application Support/AppBridge"
appbridge_cache_base="${appbridge_workspace}/runtime"
appbridge_legacy_cache_base="${HOME}/Library/Caches/AppBridge"
appbridge_cache="${appbridge_cache_base}/__VERSION__-${appbridge_digest[1,12]}"
appbridge_cached_app="${appbridge_cache}/AppBridge.app"
if [[ "$(/usr/bin/uname -s)" != Darwin || "$(/usr/bin/uname -m)" != arm64 ]]; then
  print '本版需要 Apple 芯片的 Mac。'; exit 1
fi
if [[ -L "${appbridge_workspace}" || -L "${appbridge_cache_base}" || -L "${appbridge_cache}" || -L "${appbridge_cached_app}" ]]; then
  print 'AppBridge 工作区位置是符号链接，请使用普通本机文件夹。'; exit 1
fi
appbridge_verify_app() {
  local appbridge_candidate="$1"
  local appbridge_attributes
  [[ -d "${appbridge_candidate}" && ! -L "${appbridge_candidate}" ]] || return 1
  /usr/bin/codesign --verify --deep --strict "${appbridge_candidate}" 2>/dev/null || return 1
  appbridge_attributes="$(/usr/bin/xattr -r "${appbridge_candidate}" 2>/dev/null)" || return 1
  if [[ "${appbridge_attributes:l}" == *fileprovider* || "${appbridge_attributes:l}" == *finderinfo* || "${appbridge_attributes:l}" == *resourcefork* ]]; then
    return 1
  fi
}
if ! appbridge_verify_app "${appbridge_cached_app}"; then
  if [[ ! -f "${appbridge_archive}" ]]; then
    print '请先在 iCloud 云盘中完整下载 AppBridge 软件包。'; exit 1
  fi
  print '正在校验云盘软件包，并准备 AppBridge 工作区运行文件…'
  appbridge_actual="$(/usr/bin/shasum -a 256 "${appbridge_archive}" | /usr/bin/awk '{print $1}')"
  if [[ "${appbridge_actual}" != "${appbridge_digest}" ]]; then
    print '软件包校验不一致，已停止运行。请重新构建或取得完整的软件包。'; exit 1
  fi
  /bin/mkdir -p "${appbridge_cache_base}"
  appbridge_stage="$(/usr/bin/mktemp -d "${appbridge_cache_base}/.prepare.XXXXXXXX")"
  trap '[[ -z "${appbridge_stage:-}" || ! -d "${appbridge_stage}" ]] || /bin/rm -rf "${appbridge_stage}"' EXIT
  /usr/bin/ditto -x -k "${appbridge_archive}" "${appbridge_stage}"
  if ! appbridge_verify_app "${appbridge_stage}/AppBridge.app"; then
    print '工作区运行文件未通过完整性检查，已停止。'; exit 1
  fi
  if [[ -e "${appbridge_cache}" ]]; then
    /bin/mv "${appbridge_cache}" "${appbridge_cache}.previous.$(/bin/date +%s)"
  fi
  /bin/mv "${appbridge_stage}" "${appbridge_cache}"
  appbridge_stage=''
fi
if [[ -L "${HOME}/Applications/AppBridge.app" ]]; then
  appbridge_old_link="$(/usr/bin/readlink "${HOME}/Applications/AppBridge.app")"
  if [[ "${appbridge_old_link}" == "${appbridge_cache_base}/"* || "${appbridge_old_link}" == "${appbridge_legacy_cache_base}/"* || "${appbridge_old_link}" == "${appbridge_cloud_directory}/AppBridge.app" ]]; then
    /bin/ln -sfn "${appbridge_cached_app}" "${HOME}/Applications/AppBridge.app"
  fi
fi
/usr/bin/open "${appbridge_cached_app}"
