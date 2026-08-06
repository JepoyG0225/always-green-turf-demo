/* ─────────────────────────────────────────────────────────────────────────
   Always Green Turf — Lead-form spam guard
   Exposes window.AGTFormValidation.{validatePhone, validateEmail, scrub}
   Called by every form submit handler before posting to the webhook.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Disposable / throwaway email domains (curated, lower-cased) ──────────
  // Source: common public lists trimmed to high-signal entries only.
  var DISPOSABLE_DOMAINS = [
    '0815.ru','10minutemail.com','10minutemail.net','20minutemail.com',
    'anonymbox.com','armyspy.com','boun.cr','bouncr.com','bccto.me',
    'binkmail.com','byom.de','cuvox.de','dayrep.com','dispostable.com',
    'einrot.com','emailfake.com','emailondeck.com','emltmp.com',
    'fakeinbox.com','fakemailgenerator.com','fastmail.cn','fleckens.hu',
    'gawab.com','getairmail.com','getnada.com','grr.la','guerrillamail.biz',
    'guerrillamail.com','guerrillamail.de','guerrillamail.info','guerrillamail.net',
    'guerrillamail.org','harakirimail.com','hidemail.de','imgof.com',
    'incognitomail.com','inboxalias.com','inboxbear.com','jetable.org',
    'jourrapide.com','kasmail.com','keemail.me','klzlk.com','letthemeatspam.com',
    'lroid.com','mail-temporaire.fr','mail.tm','mail7.io','maildrop.cc',
    'mailcatch.com','mailde.de','mailde.info','mailfreeonline.com',
    'mailfs.com','mailhz.me','mailimate.com','mailin8r.com','mailinator.com',
    'mailinator.net','mailinator2.com','mailmoat.com','mailnesia.com',
    'mailnull.com','mailrock.biz','mailshell.com','mailsiphon.com',
    'mailtemp.uk','mailto.de','maildump.tk','mailfa.tk','mintemail.com',
    'mohmal.com','moncourrier.fr','monmail.fr','msgwire.com','mt2014.com',
    'mt2015.com','my10minutemail.com','mytemp.email','mytempmail.com',
    'nepwk.com','no-spam.ws','nomail.xl.cx','nospam.ze.tc','noyours.com',
    'objectmail.com','ohi.tw','onewaymail.com','opentrash.com','orangatango.com',
    'pjjkp.com','plexolan.de','pookmail.com','privymail.de','proxymail.eu',
    'putthisinyourspamdatabase.com','qisdo.com','quickinbox.com','rcpt.at',
    'rmqkr.net','rppkn.com','rtrtr.com','sharklasers.com','shitmail.me',
    'shortmail.net','sneakemail.com','snkmail.com','solvemail.info',
    'spam4.me','spamavert.com','spambox.us','spamcero.com','spamday.com',
    'spamex.com','spamfree.eu','spamfree24.com','spamfree24.de','spamfree24.eu',
    'spamfree24.info','spamfree24.net','spamfree24.org','spamhole.com',
    'spaminator.de','spamslicer.com','speed.1s.fr','speedgaus.net',
    'tafmail.com','tagyourself.com','teleworm.com','teleworm.us','temp-mail.org',
    'temp-mail.ru','tempemail.biz','tempemail.co.za','tempemail.com',
    'tempemail.net','tempinbox.co.uk','tempinbox.com','tempmail.com',
    'tempmail.eu','tempmail.it','tempmaildemo.com','tempmailer.com',
    'tempmailer.de','tempomail.fr','tempymail.com','tfwno.gf','thanksnospam.info',
    'thankyou2010.com','thecloudindex.com','tilien.com','tittbit.in',
    'tmail.ws','tmailinator.com','tmpjr.me','toiea.com','toomail.biz',
    'topranklist.de','tradermail.info','trash-amil.com','trash-mail.at',
    'trash-mail.com','trash-mail.de','trash2009.com','trashemail.de',
    'trashmail.at','trashmail.com','trashmail.de','trashmail.me','trashmail.net',
    'trashmail.org','trashmail.ws','trashymail.com','trbvm.com','trgovinanaveliko.info',
    'trialmail.de','trillianpro.com','tryalert.com','turual.com','twinmail.de',
    'tyldd.com','uggsrock.com','umail.net','upliftnow.com','uplipht.com',
    'venompen.com','veryrealemail.com','vidchart.com','viralplays.com',
    'vmpanda.com','wegwerf-email-addressen.de','wegwerf-emails.de','wegwerfadresse.de',
    'wegwerfemail.com','wegwerfemail.de','wegwerfemailadresse.com','wegwerfmail.de',
    'wegwerfmail.info','wegwerfmail.net','wegwerfmail.org','wh4f.org','whyspam.me',
    'willhackforfood.biz','wilemail.com','willselfdestruct.com','winemaven.info',
    'wuzup.net','wuzupmail.net','www.e4ward.com','xemaps.com','xents.com',
    'xmaily.com','xoxy.net','yapped.net','yeah.net','yep.it','yogamaven.com',
    'yopmail.com','yopmail.fr','yopmail.net','ypmail.webarnak.fr.eu.org',
    'yuurok.com','zehnminutenmail.de','zoaxe.com','zoemail.org'
  ];

  // ── Spam-flag heuristics ──────────────────────────────────────────────────
  // 1) Reject any phone where every digit is the same (1111111111).
  // 2) Reject explicit sequential ramps.
  var REPEATED_DIGIT_RE = /^(\d)\1+$/;
  var SEQUENTIAL_PHONES = ['0123456789', '1234567890', '0987654321', '9876543210'];

  // 555-01XX is reserved for fictional use (movies/TV).
  function isFictional555(phone10) {
    return phone10.slice(3, 6) === '555' && /^01\d\d$/.test(phone10.slice(6));
  }

  /**
   * Detect input that's clearly an international number (not US/NANP).
   *   - "+<X>..." where X is anything other than 1
   *   - "00<X>..." (international access prefix used outside the US)
   * Accepts the raw user-typed string.
   */
  function isInternational(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return false;
    if (/^\+\s*[02-9]/.test(s)) return true;
    if (/^00\s*[2-9]/.test(s)) return true;
    return false;
  }

  /**
   * Validate a US phone number against North American Numbering Plan rules.
   *   - Strips all non-digit characters before checking.
   *   - Accepts 10 digits, or 11 digits with leading "1" country code.
   *   - Rejects any input flagged as international (+44, +33, 00‑prefixed…).
   *   - Area code and exchange must each start with 2-9.
   *   - Rejects all-same-digit, common test sequences, fictional 555-01XX,
   *     and a small list of known invalid area codes.
   * @returns {{valid: boolean, reason?: string, normalized?: string}}
   */
  function validatePhone(raw) {
    if (raw == null) return { valid: false, reason: 'Phone number is required.' };
    if (isInternational(raw)) {
      return { valid: false, reason: 'Only US phone numbers are accepted.' };
    }
    var digits = String(raw).replace(/\D/g, '');
    if (!digits) return { valid: false, reason: 'Phone number is required.' };

    var phone;
    if (digits.length === 10) {
      phone = digits;
    } else if (digits.length === 11) {
      if (digits.charAt(0) !== '1') {
        return { valid: false, reason: 'Only US phone numbers are accepted.' };
      }
      phone = digits.slice(1);
    } else if (digits.length > 11) {
      return { valid: false, reason: 'Only US phone numbers are accepted.' };
    } else {
      return { valid: false, reason: 'Please enter a 10-digit US phone number.' };
    }

    var area = phone.slice(0, 3);
    var exchange = phone.slice(3, 6);

    if (!/^[2-9]/.test(area)) {
      return { valid: false, reason: "US area code can't start with 0 or 1." };
    }
    if (!/^[2-9]/.test(exchange)) {
      return { valid: false, reason: "That phone number isn't a valid US format." };
    }
    if (REPEATED_DIGIT_RE.test(phone)) {
      return { valid: false, reason: 'Please enter a real phone number.' };
    }
    if (SEQUENTIAL_PHONES.indexOf(phone) !== -1) {
      return { valid: false, reason: 'Please enter a real phone number.' };
    }
    if (isFictional555(phone)) {
      return { valid: false, reason: 'Please enter a real phone number.' };
    }
    // Reserved/unassigned area codes used as placeholder spam.
    if (['000', '111', '555'].indexOf(area) !== -1) {
      return { valid: false, reason: 'Please enter a real phone number.' };
    }

    return { valid: true, normalized: phone };
  }

  /**
   * Validate an email address. Optional — empty string returns valid:true so
   * forms that treat email as optional don't break.
   * Rejects:
   *   - Invalid format (basic RFC-ish check).
   *   - Disposable / temp-mail domains.
   *   - 5+ identical characters in a row in the local part (gibberish).
   *   - Local parts of 1 char or all-numeric runs longer than 12 digits.
   * @returns {{valid: boolean, reason?: string, normalized?: string}}
   */
  function validateEmail(raw) {
    if (raw == null) return { valid: true, normalized: '' };
    var email = String(raw).trim().toLowerCase();
    if (!email) return { valid: true, normalized: '' };

    // Basic format
    var re = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}$/;
    if (!re.test(email)) {
      return { valid: false, reason: 'Please enter a valid email address.' };
    }

    var parts = email.split('@');
    var local = parts[0];
    var domain = parts[1];

    if (DISPOSABLE_DOMAINS.indexOf(domain) !== -1) {
      return { valid: false, reason: 'Please use a permanent email address.' };
    }
    // 5+ same characters in a row in local part (e.g., "aaaaaa@x.com").
    if (/(.)\1{4,}/.test(local)) {
      return { valid: false, reason: 'That email looks invalid.' };
    }
    // Local part too short.
    if (local.length < 2) {
      return { valid: false, reason: 'That email looks invalid.' };
    }
    // 13+ digits in a row inside the local part is almost always spam.
    if (/\d{13,}/.test(local)) {
      return { valid: false, reason: 'That email looks invalid.' };
    }

    return { valid: true, normalized: email };
  }

  /**
   * One-call helper used by submit handlers. Pass an object with the raw
   * phone (required) and email (optional) field values; receive either
   * `{ ok: true, phone, email }` for use in the webhook payload, or
   * `{ ok: false, reason }` to surface to the user.
   */
  function scrub(input) {
    var phoneResult = validatePhone(input.phone);
    if (!phoneResult.valid) return { ok: false, reason: phoneResult.reason };
    var emailResult = validateEmail(input.email);
    if (!emailResult.valid) return { ok: false, reason: emailResult.reason };
    return { ok: true, phone: phoneResult.normalized, email: emailResult.normalized };
  }

  // ── Real-time field formatting & live validation ────────────────────────
  /** Format a digit string (≤10 digits) as "(XXX) XXX-XXXX" partial. */
  function formatPhoneAsTyping(digits) {
    if (!digits) return '';
    if (digits.length <= 3) return '(' + digits;
    if (digits.length <= 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6, 10);
  }

  function ensureErrorElement(input) {
    var next = input.nextElementSibling;
    if (next && next.classList && next.classList.contains('agt-field-error')) return next;
    var el = document.createElement('span');
    el.className = 'agt-field-error';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText =
      'display:none; color:#c0392b; font-size:.7rem; font-weight:600;' +
      'margin-top:5px; line-height:1.4; letter-spacing:.01em;';
    input.insertAdjacentElement('afterend', el);
    return el;
  }

  function showError(input, errEl, msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
    input.setAttribute('aria-invalid', 'true');
    input.style.borderColor = '#c0392b';
  }
  function clearError(input, errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
    input.removeAttribute('aria-invalid');
    input.style.borderColor = '';
  }

  function attachPhoneFormatter(input) {
    if (input.dataset.agtPhoneBound === '1') return;
    input.dataset.agtPhoneBound = '1';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'tel');
    // "(XXX) XXX-XXXX" is 14 characters — block keystrokes past that.
    input.setAttribute('maxlength', '14');
    var errEl = ensureErrorElement(input);

    input.addEventListener('input', function () {
      // Reject international pastes ("+44…", "+33…", "0044…") before stripping.
      if (isInternational(input.value)) {
        input.value = '';
        showError(input, errEl, 'Only US phone numbers are accepted.');
        return;
      }
      var digits = input.value.replace(/\D/g, '');
      // Tolerate users who paste "+1" / "1-XXX-..."; treat leading 1 as US country code.
      if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
      if (digits.length > 10) digits = digits.slice(0, 10);
      input.value = formatPhoneAsTyping(digits);

      if (digits.length === 0) { clearError(input, errEl); return; }
      if (digits.length < 10) {
        showError(input, errEl, 'Please enter a 10-digit US phone number.');
        return;
      }
      var r = validatePhone(digits);
      if (r.valid) clearError(input, errEl);
      else showError(input, errEl, r.reason);
    });

    input.addEventListener('blur', function () {
      var raw = input.value.replace(/\D/g, '');
      if (!raw) return;
      var r = validatePhone(raw);
      if (!r.valid) showError(input, errEl, r.reason);
    });
  }

  function attachEmailValidator(input) {
    if (input.dataset.agtEmailBound === '1') return;
    input.dataset.agtEmailBound = '1';
    input.setAttribute('autocomplete', 'email');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    var errEl = ensureErrorElement(input);

    function check() {
      var v = input.value.trim();
      if (!v) { clearError(input, errEl); return; }
      var r = validateEmail(v);
      if (r.valid) clearError(input, errEl);
      else showError(input, errEl, r.reason);
    }
    input.addEventListener('input', check);
    input.addEventListener('blur', check);
  }

  function autoAttach(root) {
    var scope = root || document;
    var phones = scope.querySelectorAll('input[type="tel"]');
    var emails = scope.querySelectorAll('input[type="email"]');
    Array.prototype.forEach.call(phones, attachPhoneFormatter);
    Array.prototype.forEach.call(emails, attachEmailValidator);
  }

  // Run automatically once the DOM is ready (defer-scripts already wait for parsing).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { autoAttach(); });
  } else {
    autoAttach();
  }

  window.AGTFormValidation = {
    validatePhone: validatePhone,
    validateEmail: validateEmail,
    scrub: scrub,
    formatPhoneAsTyping: formatPhoneAsTyping,
    attachPhoneFormatter: attachPhoneFormatter,
    attachEmailValidator: attachEmailValidator,
    autoAttach: autoAttach
  };
})();
