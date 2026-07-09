/* 渲染:卡片 + 详情。所有 null 字段一律回退为"未注明"。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format, esc = F.esc;

  var ICON = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5Zm3.2 4.7-3.9 4a.8.8 0 0 1-1.15 0L4.8 8.9a.8.8 0 0 1 1.15-1.1l.98 1 3.32-3.4a.8.8 0 1 1 1.15 1.1Z" fill="currentColor"/></svg>',
    circle: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    heart: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    heartFill: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="currentColor"/></svg>'
  };

  function media(o) {
    // 无图 → 域名首字母 + 分类主色 色块(不留空白框)
    return '<div class="card__fallback" style="background:' + F.catColor(o.category) + '">' +
           '<span>' + esc(F.initial(o)) + '</span></div>';
  }

  function trustBadge(o) {
    if (o.trust === "verified") {
      var when = o.verified_at ? " · " + o.verified_at.slice(5) : "";
      return '<span class="trust trust--verified">' + ICON.check + AP.t("trustVerified") + when + '</span>';
    }
    return '<span class="trust trust--auto">' + ICON.circle + AP.t("trustAuto") + '</span>';
  }

  AP.renderCard = function (o) {
    var dl = F.deadline(o);
    var fees = F.feeBadges(o).map(function (b) { return '<span class="badge ' + b.cls + '">' + esc(b.text) + '</span>'; }).join("");
    var funds = F.fundingBadges(o).map(function (t) { return '<span class="badge badge--fund">' + esc(t) + '</span>'; }).join("");
    var titleEn = o.title_en ? '<div class="card__title-en">' + esc(o.title_en) + '</div>' : "";
    var place = [o.city_zh, o.country_zh].filter(Boolean).join(" · ") || AP.t("notStated");
    var orgTag = AP.tt[AP.lang].org[o.org_type] || o.org_type || "";

    var el = document.createElement("article");
    el.className = "card";
    el.setAttribute("data-id", o.id);
    el.innerHTML =
      '<div class="card__media">' + media(o) +
        '<div class="card__tags">' +
          '<span class="cat-tag" data-cat="' + esc(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
          (orgTag ? '<span class="org-tag">' + esc(orgTag) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="card__body">' +
        '<div>' +
          '<h2 class="card__title">' + esc(o.title_zh || o.title_en || "") + '</h2>' + titleEn +
        '</div>' +
        '<div class="card__meta">' +
          '<span class="m-org">' + esc(o.org_zh || AP.t("notStated")) + '</span>' +
          '<span>' + esc(place) + '</span>' +
        '</div>' +
        '<div class="card__deadline ' + dl.cls + '">' + esc(dl.text) + '</div>' +
        (fees || funds ? '<div class="badges">' + fees + funds + '</div>' : '') +
        '<div>' + trustBadge(o) + '</div>' +
        '<div class="card__foot">' +
          '<button class="btn btn--ghost" data-act="copy" type="button">' + AP.t("copyLink") + '</button>' +
          '<a class="btn btn--dark" data-act="visit" href="' + esc(o.url || "#") + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>' +
        '</div>' +
      '</div>';
    return el;
  };

  // ---------- 详情 ----------
  function row(k, vHtml) {
    return '<div class="d-row"><div class="d-row__k">' + esc(k) + '</div><div class="d-row__v">' + vHtml + '</div></div>';
  }
  function muted(text) { return '<span class="muted">' + esc(text) + '</span>'; }

  function fundLine(label, v) {
    var val = v === true ? AP.t("provided") : (v === false ? AP.t("notProvided") : null);
    return esc(label) + ": " + (val ? esc(val) : muted(AP.t("notStated")));
  }
  function feeVal(feeObj, isPart) {
    if (!feeObj) return muted(AP.t("notStated"));
    if (isPart) {
      if (feeObj.required === true) {
        var t = AP.t("yes");
        if (feeObj.amount != null && feeObj.amount > 0) t += " · " + F.money(feeObj.amount, feeObj.currency);
        return '<span style="color:var(--warn);font-weight:600">' + esc(t) + '</span>';
      }
      if (feeObj.required === false) return esc(AP.t("no"));
      return muted(AP.t("notStated"));
    } else {
      if (feeObj.free === true) return '<span style="color:var(--ok);font-weight:600">' + esc(AP.t("free")) + '</span>';
      if (feeObj.free === false) return esc((feeObj.amount != null && feeObj.amount > 0) ? F.money(feeObj.amount, feeObj.currency) : AP.t("applyFee"));
      return muted(AP.t("notStated"));
    }
  }
  function eligVal(o) {
    var e = o.eligibility || {};
    var parts = [];
    if (e.students_ok === true) parts.push(AP.t("students") + ": " + AP.t("yes"));
    else if (e.students_ok === false) parts.push(AP.t("students") + ": " + AP.t("no"));
    if (e.age_limit) parts.push(AP.t("age") + ": " + e.age_limit);
    if (e.nationality) parts.push(AP.t("nationality") + ": " + e.nationality);
    if (!parts.length) return muted(AP.t("notStated"));
    return parts.map(esc).join("<br>");
  }

  AP.renderDetail = function (o) {
    var dl = F.deadline(o);
    var place = [o.city_zh, o.country_zh].filter(Boolean).join(" · ");
    var disc = (o.disciplines && o.disciplines.length) ? o.disciplines.map(esc).join("、") : muted(AP.t("notStated"));
    var reportSubject = encodeURIComponent("[ArtPortal] " + AP.t("reportErr") + " " + o.id);
    var alert = o.trust === "auto"
      ? '<div class="d-alert">' + ICON.circle + '<span>' + esc(AP.t("autoNotice")) + '</span></div>'
      : '';
    var fundHtml = fundLine(AP.t("stipend"), (o.funding || {}).stipend) + "　" +
                   fundLine(AP.t("housing"), (o.funding || {}).housing) + "　" +
                   fundLine(AP.t("travel"), (o.funding || {}).travel);
    var dnote = o.deadline_note ? ' <span class="muted">(' + esc(o.deadline_note) + ')</span>' : '';

    var html =
      '<div class="d-head">' +
        '<span class="d-cat" style="background:' + F.catColor(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
        '<h1 class="d-title" id="detailTitle">' + esc(o.title_zh || o.title_en || "") + '</h1>' +
        (o.title_en ? '<div class="d-title-en">' + esc(o.title_en) + '</div>' : '') +
      '</div>' +
      '<div>' + trustBadge(o) + '</div>' +
      alert +
      '<div class="d-fields">' +
        row(AP.t("dOrg"), esc(o.org_zh) || muted(AP.t("notStated"))) +
        row(AP.t("dPlace"), place ? esc(place) : muted(AP.t("notStated"))) +
        row(AP.t("dDeadline"), '<span class="' + dl.cls + '">' + esc(dl.text) + '</span>' + dnote) +
        row(AP.t("dApplyFee"), feeVal(o.apply_fee, false)) +
        row(AP.t("dPartFee"), feeVal(o.participation_fee, true)) +
        row(AP.t("dFunding"), fundHtml) +
        row(AP.t("dEligibility"), eligVal(o)) +
        row(AP.t("dDisc"), disc) +
        row(AP.t("dUrl"), o.url ? '<a href="' + esc(o.url) + '" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(AP.t("visit")) + '</a>' : muted(AP.t("notStated"))) +
        row(AP.t("dSource"), o.source_url ? '<a href="' + esc(o.source_url) + '" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(o.domain || AP.t("visit")) + '</a>' : muted(AP.t("notStated"))) +
        row(AP.t("dSeen"), esc(o.last_seen) || muted(AP.t("notStated"))) +
      '</div>' +
      '<div class="d-actions">' +
        '<button class="btn btn--ghost" data-act="copy" data-id="' + esc(o.id) + '" type="button">' + AP.t("copyLink") + '</button>' +
        '<a class="btn btn--dark" href="' + esc(o.url || "#") + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>' +
      '</div>' +
      '<p class="d-report">' + esc(AP.t("reportErr")) + ' <a href="mailto:atsang799@gmail.com?subject=' + reportSubject + '">' + esc(AP.t("reportLink")) + '</a></p>';
    return html;
  };

  AP.ICON = ICON;
})();
