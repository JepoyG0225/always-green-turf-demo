import os
import glob

ROOT = r'C:\Users\Admin\Desktop\always-green-turf-demo'

# Only root-level HTML files (not subfolders)
html_files = [f for f in glob.glob(os.path.join(ROOT, '*.html'))]

CSS_SENTINEL = '.n-dropdown-wide'
CSS_AFTER = '    .n-dropdown li a:hover { color:#fff; background:rgba(255,255,255,.07); }'
CSS_INSERT = """    .n-dropdown-wide { min-width:420px; padding:8px; display:grid; grid-template-columns:1fr 1fr; list-style:none; }
    .n-dropdown-wide li a { padding:7px 12px; font-size:.74rem; }
    #nMobSubAreas { display:grid; grid-template-columns:1fr 1fr; padding-left:0; gap:0; }
    #nMobSubAreas.open { max-height:1000px; }"""

DESKTOP_OLD = '    <li><a href="service-areas.html">Service Areas</a></li>'
DESKTOP_NEW = """    <li class="has-drop">
      <a href="service-area.html">Service Areas <span class="arrow">▼</span></a>
      <ul class="n-dropdown n-dropdown-wide">
        <li><a href="service-area.html?city=mesa">Mesa</a></li>
        <li><a href="service-area.html?city=chandler">Chandler</a></li>
        <li><a href="service-area.html?city=gilbert">Gilbert</a></li>
        <li><a href="service-area.html?city=tempe">Tempe</a></li>
        <li><a href="service-area.html?city=ahwatukee">Ahwatukee</a></li>
        <li><a href="service-area.html?city=queen-creek">Queen Creek</a></li>
        <li><a href="service-area.html?city=san-tan-valley">San Tan Valley</a></li>
        <li><a href="service-area.html?city=apache-junction">Apache Junction</a></li>
        <li><a href="service-area.html?city=gold-canyon">Gold Canyon</a></li>
        <li><a href="service-area.html?city=maricopa">Maricopa</a></li>
        <li><a href="service-area.html?city=phoenix">Phoenix</a></li>
        <li><a href="service-area.html?city=scottsdale">Scottsdale</a></li>
        <li><a href="service-area.html?city=paradise-valley">Paradise Valley</a></li>
        <li><a href="service-area.html?city=anthem">Anthem</a></li>
        <li><a href="service-area.html?city=cave-creek">Cave Creek</a></li>
        <li><a href="service-area.html?city=carefree">Carefree</a></li>
        <li><a href="service-area.html?city=fountain-hills">Fountain Hills</a></li>
        <li><a href="service-area.html?city=rio-verde">Rio Verde</a></li>
        <li><a href="service-area.html?city=laveen">Laveen</a></li>
        <li><a href="service-area.html?city=glendale">Glendale</a></li>
        <li><a href="service-area.html?city=peoria">Peoria</a></li>
        <li><a href="service-area.html?city=surprise">Surprise</a></li>
        <li><a href="service-area.html?city=goodyear">Goodyear</a></li>
        <li><a href="service-area.html?city=avondale">Avondale</a></li>
        <li><a href="service-area.html?city=buckeye">Buckeye</a></li>
        <li><a href="service-area.html?city=litchfield-park">Litchfield Park</a></li>
        <li><a href="service-area.html?city=sun-city">Sun City</a></li>
        <li><a href="service-area.html?city=sun-city-west">Sun City West</a></li>
        <li><a href="service-area.html?city=tolleson">Tolleson</a></li>
      </ul>
    </li>"""

MOB_OLD = '    <li><a href="service-areas.html" class="n-mob-a">Service Areas</a></li>'
MOB_NEW = """    <li class="n-mob-has-drop">
      <button class="n-mob-drop-btn" id="nMobDropAreas">Service Areas <span class="n-mob-arrow">▼</span></button>
      <ul class="n-mob-sub" id="nMobSubAreas">
        <li><a href="service-area.html?city=mesa">Mesa</a></li>
        <li><a href="service-area.html?city=chandler">Chandler</a></li>
        <li><a href="service-area.html?city=gilbert">Gilbert</a></li>
        <li><a href="service-area.html?city=tempe">Tempe</a></li>
        <li><a href="service-area.html?city=ahwatukee">Ahwatukee</a></li>
        <li><a href="service-area.html?city=queen-creek">Queen Creek</a></li>
        <li><a href="service-area.html?city=san-tan-valley">San Tan Valley</a></li>
        <li><a href="service-area.html?city=apache-junction">Apache Junction</a></li>
        <li><a href="service-area.html?city=gold-canyon">Gold Canyon</a></li>
        <li><a href="service-area.html?city=maricopa">Maricopa</a></li>
        <li><a href="service-area.html?city=phoenix">Phoenix</a></li>
        <li><a href="service-area.html?city=scottsdale">Scottsdale</a></li>
        <li><a href="service-area.html?city=paradise-valley">Paradise Valley</a></li>
        <li><a href="service-area.html?city=anthem">Anthem</a></li>
        <li><a href="service-area.html?city=cave-creek">Cave Creek</a></li>
        <li><a href="service-area.html?city=carefree">Carefree</a></li>
        <li><a href="service-area.html?city=fountain-hills">Fountain Hills</a></li>
        <li><a href="service-area.html?city=rio-verde">Rio Verde</a></li>
        <li><a href="service-area.html?city=laveen">Laveen</a></li>
        <li><a href="service-area.html?city=glendale">Glendale</a></li>
        <li><a href="service-area.html?city=peoria">Peoria</a></li>
        <li><a href="service-area.html?city=surprise">Surprise</a></li>
        <li><a href="service-area.html?city=goodyear">Goodyear</a></li>
        <li><a href="service-area.html?city=avondale">Avondale</a></li>
        <li><a href="service-area.html?city=buckeye">Buckeye</a></li>
        <li><a href="service-area.html?city=litchfield-park">Litchfield Park</a></li>
        <li><a href="service-area.html?city=sun-city">Sun City</a></li>
        <li><a href="service-area.html?city=sun-city-west">Sun City West</a></li>
        <li><a href="service-area.html?city=tolleson">Tolleson</a></li>
      </ul>
    </li>"""

JS_BEFORE = '    const dropBtn = document.getElementById(\'nMobDrop\');'
JS_INSERT = """    const areasBtn = document.getElementById('nMobDropAreas');
    const areasSub = document.getElementById('nMobSubAreas');
    if(areasBtn && areasSub){
      areasBtn.addEventListener('click', () => {
        const open = areasSub.classList.toggle('open');
        areasBtn.classList.toggle('open', open);
      });
    }"""

JS_SENTINEL = 'nMobDropAreas'

updated = []
skipped = []

for fpath in sorted(html_files):
    fname = os.path.basename(fpath)
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()

    reasons = []
    already_done = CSS_SENTINEL in content  # single sentinel check covers all 4 changes

    if already_done:
        skipped.append((fname, 'already updated (sentinel found)'))
        continue

    original = content
    changed = []

    # 1. CSS insertion
    if CSS_AFTER in content:
        content = content.replace(CSS_AFTER, CSS_AFTER + '\n' + CSS_INSERT, 1)
        changed.append('CSS')
    else:
        reasons.append('CSS anchor line not found')

    # 2. Desktop nav
    if DESKTOP_OLD in content:
        content = content.replace(DESKTOP_OLD, DESKTOP_NEW, 1)
        changed.append('desktop-nav')
    else:
        reasons.append('desktop nav anchor not found')

    # 3. Mobile nav
    if MOB_OLD in content:
        content = content.replace(MOB_OLD, MOB_NEW, 1)
        changed.append('mobile-nav')
    else:
        reasons.append('mobile nav anchor not found')

    # 4. JS insertion
    if JS_BEFORE in content:
        content = content.replace(JS_BEFORE, JS_INSERT + '\n' + JS_BEFORE, 1)
        changed.append('JS')
    else:
        reasons.append('JS anchor line not found')

    if content != original:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(content)
        updated.append((fname, changed))
    else:
        skipped.append((fname, 'no anchors matched: ' + '; '.join(reasons)))

print('=== UPDATED ===')
for fname, changes in updated:
    print(f'  {fname}: {", ".join(changes)}')

print('\n=== SKIPPED ===')
for fname, reason in skipped:
    print(f'  {fname}: {reason}')
