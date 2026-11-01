#!/usr/bin/env python3
"""Pack the unpacked Windows directory into a portable zip (no installer).

usage: make-portable-zip.py <win-unpacked dir> <output zip> <product name> <version>

The archive holds one top-level folder named after the product so that extracting
it never scatters files into the destination. A short Chinese usage note is added
at the folder root. Entries are deflated; Windows Explorer opens the archive
without extra tools.
"""
import os
import sys
import zipfile

USAGE_NOTE = """{product} {version} 免安装版（未签名）

使用：
1. 先别急着解压。右键这个 zip → 属性 → 在底部勾选「解除锁定」→ 确定。
   （不做这一步也能用，只是解压出来的 {product}.exe 第一次运行时 Windows 会提示「未知发布者」，
   点「更多信息」→「仍要运行」即可。）
2. 解压到任意文件夹（建议路径不要太深，也不要放在 C:\\Program Files 里）。
3. 双击 {product}.exe 启动。

数据位置：%APPDATA%\\{product}（会话、设置等）。
卸载：关闭程序，删除解压出来的文件夹即可；要清除数据，再删掉上面的数据目录。
更新：免安装版不能自动更新；有新版本时下载新的压缩包，解压覆盖或解压到新文件夹即可，数据目录不变。

如果杀毒软件或 Windows 提示被拦截，请先确认文件来源可信，再选择允许。
"""


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    source, output, product, version = sys.argv[1:]
    if not os.path.isfile(os.path.join(source, f"{product}.exe")):
        print(f"make-portable-zip: {product}.exe not found in {source}", file=sys.stderr)
        return 1
    if os.path.exists(output):
        os.remove(output)
    count = 0
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        archive.writestr(f"{product}/使用说明.txt", USAGE_NOTE.format(product=product, version=version).replace("\n", "\r\n"))
        for directory, _names, files in os.walk(source):
            for name in sorted(files):
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, source).replace(os.sep, "/")
                archive.write(path, f"{product}/{relative}")
                count += 1
    print(f"make-portable-zip: {count} files -> {output} ({os.path.getsize(output)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
