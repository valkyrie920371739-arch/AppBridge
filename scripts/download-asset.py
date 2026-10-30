#!/usr/bin/env python3
"""Fetch a pinned GitHub release asset in resumable, verified byte ranges."""
import concurrent.futures, hashlib, pathlib, subprocess, sys, tempfile, urllib.parse
api, output, total_text, expected = sys.argv[1:]
output = pathlib.Path(output)
total = int(total_text)
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists() and hashlib.file_digest(output.open('rb'), 'sha256').hexdigest() == expected:
    print('Already verified:', output.name); sys.exit(0)
with tempfile.TemporaryDirectory() as tmp:
    headers = pathlib.Path(tmp) / 'headers'
    url = api
    for _ in range(5):
        subprocess.run(['/usr/bin/curl','-fsS','-D',str(headers),'-o','/dev/null','-H','Accept: application/octet-stream','--connect-timeout','10','--max-time','30',url],check=True)
        url = next(line.partition(':')[2].strip() for line in headers.read_text().splitlines() if line.lower().startswith('location:'))
        if urllib.parse.urlparse(url).hostname != 'api.github.com': break
    else: raise RuntimeError('Too many API redirects')
    parts = output.parent / (output.name + '.parts')
    parts.mkdir(exist_ok=True)
    count = 32 if total > 50_000_000 else 8
    block = (total + count - 1) // count
    def fetch(i):
        start, end = i * block, min(total, (i + 1) * block) - 1
        part = parts / str(i)
        if part.exists() and part.stat().st_size == end - start + 1: return part
        result = subprocess.run(['/usr/bin/curl','-fsSL','--noproxy','*','--connect-timeout','15','--max-time','300','--retry','2','-r',f'{start}-{end}','-o',str(part),url],capture_output=True,text=True)
        if result.returncode or not part.exists() or part.stat().st_size != end - start + 1:
            raise RuntimeError(f'Part {i} failed: {result.stderr[:200]}')
        return part
    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        paths = list(pool.map(fetch, range(count)))
    assembled = output.with_suffix(output.suffix + '.partial')
    digest = hashlib.sha256()
    with assembled.open('wb') as dst:
        for part in paths:
            with part.open('rb') as src:
                while chunk := src.read(1024 * 1024):
                    digest.update(chunk); dst.write(chunk)
    if digest.hexdigest() != expected:
        assembled.unlink(); raise RuntimeError('Downloaded asset checksum mismatch')
    assembled.replace(output)
    import shutil
    shutil.rmtree(parts)
    print('Verified:', output.name, digest.hexdigest(), flush=True)
