import re, os

PAGES = [
    "about.html",
    "artificial-lawns.html",
    "pet-turf.html",
    "whole-yard-renovations.html",
    "financing.html",
    "process.html",
    "service-areas.html",
    "blog.html",
    "blog-article.html",
    "putting-greens.html",
    "playground-turf.html",
]

CSS = """
    /* ── Quote Modal ── */
    #quoteModal{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;pointer-events:none;transition:opacity .3s ease;}
    #quoteModal.open{opacity:1;pointer-events:auto;}
    .qm-backdrop{position:absolute;inset:0;background:rgba(4,12,4,.72);backdrop-filter:blur(6px);cursor:pointer;}
    .qm-card{position:relative;z-index:1;background:#fff;border-radius:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 32px 80px rgba(0,0,0,.3);transform:translateY(24px) scale(.97);transition:transform .35s cubic-bezier(.22,1,.36,1);padding:44px 44px 36px;}
    #quoteModal.open .qm-card{transform:none;}
    .qm-close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.06);border:none;cursor:pointer;font-size:1.3rem;color:#777;line-height:1;display:flex;align-items:center;justify-content:center;transition:background .2s,color .2s;}
    .qm-close:hover{background:rgba(0,0,0,.12);color:#111;}
    .qm-eyebrow{font-size:.6rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#1e8a1e;margin-bottom:8px;display:inline-block;}
    .qm-title{font-size:1.4rem;font-weight:900;color:#0e1e0e;line-height:1.2;letter-spacing:-.025em;margin:0 0 10px;}
    .qm-sub{font-size:.82rem;color:#6a8a6a;line-height:1.65;margin:0 0 26px;}
    .qm-form{display:flex;flex-direction:column;gap:14px;}
    .qm-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .qm-grp{display:flex;flex-direction:column;gap:5px;}
    .qm-lbl{font-size:.72rem;font-weight:700;color:#2a3a2a;letter-spacing:.02em;}
    .qm-opt{font-weight:400;color:#aaa;}
    .qm-inp{font-family:inherit;font-size:.85rem;color:#162016;background:#f6faf6;border:1.5px solid rgba(0,0,0,.1);border-radius:10px;padding:11px 14px;outline:none;transition:border-color .2s,box-shadow .2s;width:100%;box-sizing:border-box;}
    .qm-inp:focus{border-color:#1e8a1e;box-shadow:0 0 0 3px rgba(30,138,30,.12);}
    textarea.qm-inp{resize:vertical;min-height:80px;}
    select.qm-inp{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235a7a5a' stroke-width='2.5'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px;}
    .qm-submit{margin-top:4px;display:flex;align-items:center;justify-content:center;gap:10px;padding:15px 28px;border-radius:50px;border:none;cursor:pointer;background:linear-gradient(135deg,#1e8a1e,#28b828);color:#fff;font-family:inherit;font-size:.9rem;font-weight:800;letter-spacing:.02em;box-shadow:0 8px 28px rgba(30,138,30,.38);transition:transform .25s,box-shadow .25s,filter .25s;}
    .qm-submit:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(30,138,30,.52);filter:brightness(1.06);}
    .qm-fine{font-size:.68rem;color:#bbb;text-align:center;margin:0;}
    .qm-success{text-align:center;padding:20px 0;}
    .qm-success-ico{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#1e8a1e,#28b828);color:#fff;font-size:1.8rem;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;box-shadow:0 8px 28px rgba(30,138,30,.38);}
    .qm-success h3{font-size:1.25rem;font-weight:900;color:#0e1e0e;margin:0 0 10px;}
    .qm-success p{font-size:.88rem;color:#6a8a6a;line-height:1.7;margin:0;}
    @media(max-width:540px){.qm-card{padding:32px 20px 28px;}.qm-row{grid-template-columns:1fr;}}
"""

MODAL_HTML = """
<!-- ══════════════════════ QUOTE POPUP MODAL ═════════════════════════════ -->
<div id="quoteModal" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="qmTitle">
  <div class="qm-backdrop"></div>
  <div class="qm-card">
    <button class="qm-close" aria-label="Close">&times;</button>
    <div class="qm-header">
      <div class="qm-eyebrow">Free · No Obligation</div>
      <h2 class="qm-title" id="qmTitle">Get Your Free Design Quote</h2>
      <p class="qm-sub">Our local team visits your yard, measures the space, and delivers a same-day detailed quote — no pressure, no guessing.</p>
    </div>
    <form class="qm-form" id="quoteForm" novalidate>
      <div class="qm-row">
        <div class="qm-grp">
          <label class="qm-lbl" for="qm_fname">First Name *</label>
          <input class="qm-inp" id="qm_fname" type="text" placeholder="John" required>
        </div>
        <div class="qm-grp">
          <label class="qm-lbl" for="qm_lname">Last Name *</label>
          <input class="qm-inp" id="qm_lname" type="text" placeholder="Doe" required>
        </div>
      </div>
      <div class="qm-row">
        <div class="qm-grp">
          <label class="qm-lbl" for="qm_phone">Phone *</label>
          <input class="qm-inp" id="qm_phone" type="tel" placeholder="(480) 000-0000" required>
        </div>
        <div class="qm-grp">
          <label class="qm-lbl" for="qm_email">Email</label>
          <input class="qm-inp" id="qm_email" type="email" placeholder="john@email.com">
        </div>
      </div>
      <div class="qm-grp">
        <label class="qm-lbl" for="qm_service">Service Interested In</label>
        <select class="qm-inp" id="qm_service">
          <option value="">Select a service…</option>
          <option>Residential Lawn</option>
          <option>Pet Turf</option>
          <option>Putting Green</option>
          <option>Playground Turf</option>
          <option>Whole Yard Renovation</option>
          <option>Commercial Turf</option>
          <option>Other / Not Sure</option>
        </select>
      </div>
      <div class="qm-grp">
        <label class="qm-lbl" for="qm_msg">Project Details <span class="qm-opt">(optional)</span></label>
        <textarea class="qm-inp" id="qm_msg" placeholder="Approximate sq ft, goals, timeline…"></textarea>
      </div>
      <button type="submit" class="qm-submit">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        Send My Free Quote Request
      </button>
      <p class="qm-fine">By submitting you agree to be contacted by Always Green Turf. No spam, ever.</p>
    </form>
    <div class="qm-success" id="qmSuccess" hidden>
      <div class="qm-success-ico">✓</div>
      <h3>We'll be in touch soon!</h3>
      <p>A member of our team will call or email you within 1 business day to schedule your free on-site visit.</p>
    </div>
  </div>
</div>
<script>
(function(){
  var modal=document.getElementById('quoteModal');
  if(!modal)return;
  var form=document.getElementById('quoteForm');
  var succ=document.getElementById('qmSuccess');

  function open(e){
    e.preventDefault();
    modal.setAttribute('aria-hidden','false');
    modal.classList.add('open');
    document.body.style.overflow='hidden';
    setTimeout(function(){modal.querySelector('.qm-inp')&&modal.querySelector('.qm-inp').focus();},120);
  }
  function close(){
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden','true');
    document.body.style.overflow='';
  }

  // Attach to all contact.html links that are NOT in nav / footer
  document.querySelectorAll('a[href="contact.html"]').forEach(function(a){
    if(!a.closest('#nav,#nMob,footer,.ft-links,.breadcrumb')){
      a.addEventListener('click',open);
    }
  });

  modal.querySelector('.qm-backdrop').addEventListener('click',close);
  modal.querySelector('.qm-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&modal.classList.contains('open'))close();});

  if(form){
    form.addEventListener('submit',function(e){
      e.preventDefault();
      form.hidden=true;
      succ.hidden=false;
      setTimeout(function(){close();setTimeout(function(){form.hidden=false;succ.hidden=true;form.reset();},400);},3200);
    });
  }
})();
</script>
"""

base = os.path.dirname(os.path.abspath(__file__))

for page in PAGES:
    path = os.path.join(base, page)
    if not os.path.exists(path):
        print(f"SKIP (not found): {page}")
        continue

    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()

    # Skip if already injected
    if 'quoteModal' in html:
        print(f"SKIP (already has modal): {page}")
        continue

    # 1. Inject CSS before first </style>
    html = html.replace('</style>', CSS + '\n  </style>', 1)

    # 2. Inject modal + script before </body>
    html = html.replace('</body>', MODAL_HTML + '\n</body>', 1)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"OK: {page}")

print("Done.")
