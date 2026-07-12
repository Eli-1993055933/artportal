/* 渲染:卡片 + 详情。所有 null 字段一律回退为"未注明"。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format, esc = F.esc;
  var REPORT_EMAIL = "atsang799@gmail.com"; // 纠错反馈邮箱(公开后可换专用邮箱)

  var ICON = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5Zm3.2 4.7-3.9 4a.8.8 0 0 1-1.15 0L4.8 8.9a.8.8 0 0 1 1.15-1.1l.98 1 3.32-3.4a.8.8 0 1 1 1.15 1.1Z" fill="currentColor"/></svg>',
    circle: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    heart: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    heartFill: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="currentColor"/></svg>'
  };

  function media(o, officialUrl) {
    // 降级色块(机构中文首字 + 按条目区分的分类色)始终垫底;有封面图则叠加在上,加载失败自动移除退回色块。
    var fb = '<div class="card__fallback" style="background:' + F.fallbackColor(o) + '">' +
             '<span>' + esc(F.initial(o)) + '</span></div>';
    var inner = fb;
    var coverUrl = F.safeUrl(o.cover);
    if (coverUrl) {
      // 图片加载成功才淡入覆盖色块;加载慢/失败则一直显示色块(不留白)。
      inner = fb + '<img class="card__img" src="' + esc(coverUrl) + '" alt="" loading="lazy" ' +
             'referrerpolicy="no-referrer" onload="this.classList.add(\'is-loaded\')" onerror="this.remove()">';
    }
    // 点击封面直接跳该展览/项目官网(新窗口);无官网时保持普通色块。
    if (officialUrl) {
      return '<a class="card__media-link" href="' + esc(officialUrl) + '" target="_blank" rel="noopener" ' +
             'aria-label="' + esc(AP.t("gotoSite")) + '" title="' + esc(AP.t("gotoSite")) + '">' + inner +
             '<span class="card__media-go" aria-hidden="true">' + esc(AP.t("gotoSite")) + ' ↗</span></a>';
    }
    return inner;
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
    var prov = F.provenance(o);
    var summary = o.summary_zh ? '<p class="card__summary">' + esc(o.summary_zh) + '</p>' : "";
    var srcChip = '<span class="src-chip src-chip--' + prov.kind + '">' + esc(prov.label) + '</span>';
    var visitUrl = F.safeUrl(F.officialUrl(o));
    var titleTxt = o.title_zh || o.title_en || "";
    // 标题渲染成指向深链的真 <a>:键盘可 Tab 聚焦、回车打开,读屏识别为链接;
    // 鼠标点击仍由 grid 委托统一走 goDetail(app.js 里对该链接 preventDefault)。
    var titleHtml = '<a class="card__title-link" href="#/o/' + esc(encodeURIComponent(o.id)) + '">' + esc(titleTxt) + '</a>';
    var visitBtn = visitUrl
      ? '<a class="btn btn--dark" data-act="visit" href="' + esc(visitUrl) + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>'
      : '<button class="btn btn--dark" type="button" disabled aria-disabled="true">' + AP.t("gotoSite") + '</button>';
    var predLabel = F.predictLabel(o);
    var predHtml = predLabel ? '<div class="card__predict"><span class="card__predict-ico" aria-hidden="true">◷</span>' + esc(predLabel) + '</div>' : '';
    var predictTag = F.cadence(o) ? '<span class="predict-tag" title="' + esc(AP.t("recurringTitle")) + '">◷ ' + esc(AP.t("recurringTag")) + '</span>' : '';

    var el = document.createElement("article");
    el.className = "card";
    el.setAttribute("data-id", o.id);
    el.innerHTML =
      '<div class="card__media">' + media(o, visitUrl) +
        '<div class="card__tags">' +
          '<span class="card__tags-l">' +
            '<span class="cat-tag" data-cat="' + esc(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
            predictTag +
          '</span>' +
          (orgTag ? '<span class="org-tag">' + esc(orgTag) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="card__body">' +
        '<div>' +
          '<h2 class="card__title">' + titleHtml + '</h2>' + titleEn +
        '</div>' +
        '<div class="card__meta">' +
          '<span class="m-org">' + esc(o.org_zh || AP.t("notStated")) + '</span>' +
          '<span>' + esc(place) + '</span>' +
        '</div>' +
        '<div class="card__deadline ' + dl.cls + '">' + esc(dl.text) + '</div>' +
        predHtml +
        (fees || funds ? '<div class="badges">' + fees + funds + '</div>' : '') +
        summary +
        '<div class="card__srcrow">' + trustBadge(o) + srcChip + '</div>' +
        '<div class="card__foot">' +
          '<button class="btn btn--ghost" data-act="copy" type="button">' + AP.t("copyLink") + '</button>' +
          visitBtn +
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
    var alert = o.trust === "auto"
      ? '<div class="d-alert">' + ICON.circle + '<span>' + esc(AP.t("autoNotice")) + '</span></div>'
      : '';
    var fundHtml = fundLine(AP.t("stipend"), (o.funding || {}).stipend) + "　" +
                   fundLine(AP.t("housing"), (o.funding || {}).housing) + "　" +
                   fundLine(AP.t("travel"), (o.funding || {}).travel);
    var dnote = o.deadline_note ? ' <span class="muted">(' + esc(o.deadline_note) + ')</span>' : '';

    var coverUrl = F.safeUrl(o.cover);
    var cover = coverUrl ? '<img class="d-cover" src="' + esc(coverUrl) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : '';
    var prov = F.provenance(o);
    var official = F.safeUrl(F.officialUrl(o));
    var srcUrl = F.safeUrl(o.url);
    var provNote = '<div class="d-provenance src-chip--' + prov.kind + '">' + esc(prov.detail) + '</div>';
    var summaryHtml = o.summary_zh ? '<p class="d-summary">' + esc(o.summary_zh) + '</p>' : '';
    var srcVal = '<span class="src-chip src-chip--' + prov.kind + '">' + esc(prov.label) + '</span>' +
      (srcUrl ? ' <a href="' + esc(srcUrl) + '" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(o.domain || AP.t("visit")) + '</a>' : '');
    var html =
      cover +
      '<div class="d-head">' +
        '<span class="d-cat" style="background:' + F.catColor(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
        '<h1 class="d-title" id="detailTitle">' + esc(o.title_zh || o.title_en || "") + '</h1>' +
        (o.title_en ? '<div class="d-title-en">' + esc(o.title_en) + '</div>' : '') +
      '</div>' +
      '<div>' + trustBadge(o) + '</div>' +
      alert +
      provNote +
      summaryHtml +
      '<div class="d-fields">' +
        row(AP.t("dOrg"), esc(o.org_zh) || muted(AP.t("notStated"))) +
        row(AP.t("dPlace"), place ? esc(place) : muted(AP.t("notStated"))) +
        row(AP.t("dDeadline"), '<span class="' + dl.cls + '">' + esc(dl.text) + '</span>' + dnote) +
        (F.predictLabel(o) ? row(AP.t("dPredict"), '<span class="d-predict">' + esc(F.predictLabel(o)) + '</span>') : '') +
        row(AP.t("dApplyFee"), feeVal(o.apply_fee, false)) +
        row(AP.t("dPartFee"), feeVal(o.participation_fee, true)) +
        row(AP.t("dFunding"), fundHtml) +
        row(AP.t("dEligibility"), eligVal(o)) +
        row(AP.t("dDisc"), disc) +
        row(AP.t("dUrl"), official ? '<a href="' + esc(official) + '" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(AP.t("visit")) + '</a>' + (o.official_url ? ' <span class="muted">(' + esc(AP.t("officialLocated")) + ')</span>' : '') : muted(AP.t("notStated"))) +
        row(AP.t("dSource"), srcVal) +
        row(AP.t("dSeen"), esc(o.last_seen) || muted(AP.t("notStated"))) +
      '</div>' +
      '<div class="d-actions">' +
        '<button class="btn btn--ghost" data-act="copy" data-id="' + esc(o.id) + '" type="button">' + AP.t("copyLink") + '</button>' +
        (official
          ? '<a class="btn btn--dark" href="' + esc(official) + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>'
          : '<button class="btn btn--dark" type="button" disabled aria-disabled="true">' + AP.t("gotoSite") + '</button>') +
      '</div>' +
      // 反馈用「点击复制邮箱」而非 mailto:微信内置浏览器/无邮件客户端的手机点 mailto 常无反应。
      '<p class="d-report">' + esc(AP.t("reportErr")) +
        ' <button class="mail-copy" type="button" data-act="copyemail" data-email="' + esc(REPORT_EMAIL) + '">' +
          '<span class="mail-copy__addr">' + esc(REPORT_EMAIL) + '</span>' +
          '<span class="mail-copy__hint">' + esc(AP.t("copyEmail")) + '</span>' +
        '</button></p>';
    return html;
  };

  AP.ICON = ICON;
})();
