import os

ROOT = r'C:\Users\Admin\Desktop\always-green-turf-demo'

JS_INSERT = """    const areasBtn = document.getElementById('nMobDropAreas');
    const areasSub = document.getElementById('nMobSubAreas');
    if(areasBtn && areasSub){
      areasBtn.addEventListener('click', () => {
        const open = areasSub.classList.toggle('open');
        areasBtn.classList.toggle('open', open);
      });
    }
"""

# Files that use "const drop = document.getElementById('nMobDrop');" pattern
alt_js_anchor = "    const drop = document.getElementById('nMobDrop');"
JS_SENTINEL = 'nMobDropAreas'

files_to_fix = [
    'financing.html',
    'service-areas.html',
]

for fname in files_to_fix:
    fpath = os.path.join(ROOT, fname)
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()

    if JS_SENTINEL in content:
        print(f'  {fname}: JS already present, skipping')
        continue

    if alt_js_anchor in content:
        content = content.replace(alt_js_anchor, JS_INSERT + alt_js_anchor, 1)
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f'  {fname}: JS inserted (alt anchor)')
    else:
        print(f'  {fname}: JS anchor not found - MANUAL CHECK NEEDED')
