#!/usr/bin/env python3
"""Build the static GitHub Pages / Cloudflare Pages edition into ./public."""
from pathlib import Path
import json, shutil, re, datetime

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
APPS = ROOT / 'apps'
OUT = ROOT / 'public'
VERSION = '6.1.0'

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)

# Shared frontend assets are copied once; the static pages use relative paths.
for item in WEB.iterdir():
    if item.is_file() and item.name not in {'index.html', 'workspace.html'}:
        shutil.copy2(item, OUT / item.name)


def render_page(source: Path, destination: Path, root_rel: str, title: str):
    html = source.read_text(encoding='utf-8')
    base_tag = f'<base href="{root_rel}">'
    mode_tags = f'<meta name="keal-mode" content="web"><meta name="keal-root" content="{root_rel}">'
    html = html.replace('<!--KEAL_META-->', base_tag + mode_tags)
    # Rewrite server-rooted static assets to paths relative to the page's base.
    for tag in ('href', 'src'):
        html = html.replace(f'{tag}="/', f'{tag}="')
    html = html.replace('__KEAL_V__', VERSION)
    html = html.replace('Master Desktop', 'Web Desktop').replace('KEAL Virtual Workspace V5', 'KEAL Virtual Workspace V6')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(html, encoding='utf-8')

render_page(WEB / 'index.html', OUT / 'index.html', './', 'KEAL OS Web Edition')
render_page(WEB / 'workspace.html', OUT / 'client' / 'index.html', '../', 'KEAL OS Client')

# Keep browser configuration version in lockstep with version.json.
config_out = OUT / 'config.js'
if config_out.exists():
    config_text = config_out.read_text(encoding='utf-8')
    config_text = re.sub(r'appVersion:\s*["\'][^"\']*["\']', f'appVersion: "{VERSION}"', config_text)
    config_out.write_text(config_text, encoding='utf-8')

# Keep every installable application and its isolated entry page.
shutil.copytree(APPS, OUT / 'apps')
shutil.copy2(ROOT / 'web' / 'keal-sdk.js', OUT / 'keal-sdk.js')

catalog = []
for folder in sorted(APPS.iterdir()):
    manifest_path = folder / 'manifest.json'
    if not folder.is_dir() or not manifest_path.is_file():
        continue
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        app_id = manifest.get('id')
        entry = manifest.get('entry', 'index.html')
        if app_id != folder.name or not (folder / entry).is_file():
            continue
        manifest['entry'] = entry
        catalog.append(manifest)
    except (OSError, ValueError, TypeError):
        continue
(OUT / 'apps-catalog.json').write_text(json.dumps({'catalog': catalog}, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'version.json').write_text(json.dumps({'version': VERSION, 'release_date': datetime.date.today().isoformat()}, indent=2), encoding='utf-8')

# A small web manifest is useful when users add the site to their home screen.
(OUT / '.nojekyll').write_text('', encoding='utf-8')
(OUT / 'site.webmanifest').write_text(json.dumps({
    'name': 'KEAL OS', 'short_name': 'KEAL', 'start_url': './', 'display': 'standalone',
    'background_color': '#07111e', 'theme_color': '#07111e', 'icons': []
}, indent=2), encoding='utf-8')
print(f'Built static KEAL Web Edition v{VERSION} at {OUT}')
print(f'App catalog entries: {len(catalog)}')
