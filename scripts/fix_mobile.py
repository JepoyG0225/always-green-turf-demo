import os, re

BASE = r"C:\Users\Admin\Desktop\always-green-turf-demo"

pages = [
    "index.html","about.html","artificial-lawns.html","pet-turf.html",
    "putting-greens.html","playground-turf.html","whole-yard-renovations.html",
    "financing.html","process.html","service-areas.html","service-areas-map.html",
    "contact.html","blog.html","blog-article.html"
]

CERT_CSS = """
    /* ── Cert logos: stack one-per-row on mobile ── */
    @media(max-width:640px){
      .cert-logos{ flex-direction:column; gap:28px; align-items:center; }
      .cert-logos img{ max-width:200px; width:80%; }
    }"""

REVIEWS_CSS = """
    /* ── Reviews slider: better mobile layout ── */
    @media(max-width:640px){
      .r-card{ padding:22px 18px; }
      .slider-track{ gap:10px; }
      .sl-arr{ width:38px; height:38px; }
    }"""

for fname in pages:
    fpath = os.path.join(BASE, fname)
    if not os.path.exists(fpath):
        print(f"  SKIP (not found): {fname}")
        continue
    with open(fpath, "r", encoding="utf-8") as f:
        html = f.read()

    changed = False

    # Inject cert logos mobile CSS if not already present
    if ".cert-logos{ flex-direction:column" not in html and ".cert-logos { flex-direction:column" not in html:
        if "</style>" in html:
            html = html.replace("</style>", CERT_CSS + "\n  </style>", 1)
            changed = True
            print(f"  [cert CSS] {fname}")

    # Inject reviews mobile CSS if not already present
    if "@media(max-width:640px){" in html or "@media(max-width:640px) {" in html:
        if "r-card{ padding:22px" not in html and ".r-card{ padding:22px" not in html:
            if "</style>" in html:
                html = html.replace("</style>", REVIEWS_CSS + "\n  </style>", 1)
                changed = True
                print(f"  [reviews CSS] {fname}")

    if changed:
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(html)

print("Done.")
