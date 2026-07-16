/* 渲染:卡片 + 详情。所有 null 字段一律回退为"未注明"。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format, esc = F.esc;
  var REPORT_EMAIL = "3471483657@qq.com"; // 纠错反馈邮箱

  var ICON = {
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5A6.5 6.5 0 1 0 14.5 8 6.5 6.5 0 0 0 8 1.5Zm3.2 4.7-3.9 4a.8.8 0 0 1-1.15 0L4.8 8.9a.8.8 0 0 1 1.15-1.1l.98 1 3.32-3.4a.8.8 0 1 1 1.15 1.1Z" fill="currentColor"/></svg>',
    circle: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    heart: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    heartFill: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17s-6-4-6-8.2A3.3 3.3 0 0 1 10 6a3.3 3.3 0 0 1 6 2.8C16 13 10 17 10 17Z" fill="currentColor"/></svg>'
  };

  function media(o, officialUrl) {
    // 无真实封面时用"设计海报卡"(标题+类别+主办方)垫底;有封面图则叠加在上,加载失败自动移除退回海报卡。
    var fb = '<div class="card__fallback card__fallback--art">' + F.coverArt(o) + '</div>';
    var inner = fb;
    var coverUrl = F.coverSrc(o);
    if (coverUrl) {
      // 图片加载成功才淡入覆盖色块;加载慢/失败则一直显示色块(不留白)。
      inner = fb + '<img class="card__img" src="' + esc(coverUrl) + '" alt="" loading="lazy" ' +
             'referrerpolicy="no-referrer" onload="this.classList.add(\'is-loaded\')" onerror="this.remove()">';
    }
    // 点击封面直接跳该展览/项目官网(新窗口);无官网时保持普通色块。
    if (officialUrl) {
      return '<a class="card__media-link" data-gate="official" href="' + esc(officialUrl) + '" target="_blank" rel="noopener" ' +
             'aria-label="' + esc(AP.t("gotoSite")) + '" title="' + esc(AP.t("gotoSite")) + '">' + inner +
             '<span class="card__media-go" aria-hidden="true">' + esc(AP.t("gotoSite")) + ' ↗</span></a>';
    }
    return inner;
  }

  // 该条的某字段英文是否为机器翻译(backfill-en.mjs 按字段记录于 en_mt_fields)
  function mtHas(o, field) {
    return !!(o.en_mt_fields && o.en_mt_fields.indexOf(field) !== -1);
  }
  function hasMt(o) { return !!(o.en_mt_fields && o.en_mt_fields.length); }

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
    var titleTxt = F.loc(o, "title");
    // 副标题:显示"另一种语言"的标题。中文界面只配【非机翻】的英文原名——
    // 机翻造出的英文名绝不能以"官方英文名"形态出现(反误导红线)。
    var altTitle = AP.lang === "en" ? o.title_zh : (mtHas(o, "title") ? null : o.title_en);
    var titleEn = (altTitle && altTitle !== titleTxt) ? '<div class="card__title-en">' + esc(altTitle) + '</div>' : "";
    var place = [F.loc(o, "city"), F.loc(o, "country")].filter(Boolean).join(" · ") || AP.t("notStated");
    var orgTag = AP.tt[AP.lang].org[o.org_type] || o.org_type || "";
    var prov = F.provenance(o);
    var summaryTxt = F.loc(o, "summary");
    var summary = summaryTxt ? '<p class="card__summary">' + esc(summaryTxt) + '</p>' : "";
    // EN 模式:标题或简介是机翻的卡片,来源行加小 MT 标(详情页有完整说明)
    var mtChip = (AP.lang === "en" && (mtHas(o, "title") || mtHas(o, "summary")))
      ? '<span class="src-chip src-chip--mt" title="Machine-translated">MT</span>' : "";
    var srcChip = '<span class="src-chip src-chip--' + prov.kind + '">' + esc(prov.label) + '</span>' + mtChip;
    var visitUrl = F.safeUrl(F.officialUrl(o));
    // 标题渲染成指向深链的真 <a>:键盘可 Tab 聚焦、回车打开,读屏识别为链接;
    // 鼠标点击仍由 grid 委托统一走 goDetail(app.js 里对该链接 preventDefault)。
    var titleHtml = '<a class="card__title-link" href="#/o/' + esc(encodeURIComponent(o.id)) + '">' + esc(titleTxt) + '</a>';
    var visitBtn = visitUrl
      ? '<a class="btn btn--dark" data-act="visit" data-gate="official" href="' + esc(visitUrl) + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>'
      : '<button class="btn btn--ghost" type="button" disabled aria-disabled="true">' + AP.t("noOfficial") + '</button>';
    var predLabel = F.predictLabel(o);
    var predHtml = predLabel ? '<div class="card__predict"><span class="card__predict-ico" aria-hidden="true">◷</span>' + esc(predLabel) + '</div>' : '';
    var predictTag = F.cadence(o) ? '<span class="predict-tag" title="' + esc(AP.t("recurringTitle")) + '">◷ ' + esc(AP.t("recurringTag")) + '</span>' : '';
    var st = F.itemState(o);
    var pastTag = st === "past" ? '<span class="past-tag">' + esc(AP.t("scope_past")) + '</span>' : '';

    var el = document.createElement("article");
    el.className = "card" + (st === "past" ? " card--past" : (st === "upcoming" ? " card--upcoming" : ""));
    el.setAttribute("data-id", o.id);
    el.innerHTML =
      '<div class="card__media">' + media(o, visitUrl) +
        '<div class="card__tags">' +
          '<span class="card__tags-l">' +
            '<span class="cat-tag" data-cat="' + esc(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
            predictTag + pastTag +
          '</span>' +
          (orgTag ? '<span class="org-tag">' + esc(orgTag) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="card__body">' +
        '<div>' +
          '<h2 class="card__title">' + titleHtml + '</h2>' + titleEn +
        '</div>' +
        '<div class="card__meta">' +
          '<span class="m-org">' + esc(F.loc(o, "org") || AP.t("notStated")) + '</span>' +
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

  // ---------- 资讯卡片(点击→原文) ----------
  // 封面:优先 cover 图,否则用设计海报卡(把资讯字段映射成 coverArt 认识的形状)
  function channelMedia(o, artShim) {
    var url = F.coverSrc ? F.coverSrc(o) : "";
    var fb = '<div class="card__fallback card__fallback--art">' + F.coverArt(artShim) + '</div>';
    if (!url) return fb;
    return fb + '<img class="card__img" src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add(\'is-loaded\')" onerror="this.remove()">';
  }
  // AI 检索收录的条目如实标注(与机会频道"AI 检索·请核对官网"同一条诚实红线);
  // 且资讯/招聘的双语标题有一侧是机器翻译:界面语言显示的不是原文语言时,加 MT 小标
  // (机会频道"机翻不冒充原文"红线延伸到新频道)。
  function isZhText(s) { return /[一-鿿]/.test(String(s || "")); }
  function viaChip(o) {
    var chips = "";
    if (o._via === "search") chips += '<span class="src-chip src-chip--aggregator">' + esc(AP.t("chipAiSearched")) + '</span>';
    if (o.title) {
      var showingEn = AP.lang === "en", srcIsZh = isZhText(o.title);
      if ((showingEn && srcIsZh) || (!showingEn && !srcIsZh)) {
        chips += '<span class="src-chip src-chip--mt" title="' + esc(AP.t("mtNote")) + '">MT</span>';
      }
    }
    return chips ? '<div class="card__srcrow">' + chips + '</div>' : "";
  }
  AP.renderNewsCard = function (n) {
    var title = F.loc(n, "title") || n.title || "";
    var summary = F.loc(n, "summary") || n.summary || "";
    var shim = { id: n.id, category: "news", title_zh: title, org_zh: n.source };
    var el = document.createElement("article");
    el.className = "card card--link";
    el.setAttribute("data-url", F.safeUrl(n.url));   // setAttribute 自带转义,勿再 esc(否则 &→&amp; 破坏 URL)
    var cat = n.category ? '<span class="cat-tag" data-cat="news">' + esc(n.category) + '</span>' : "";
    var date = n.published_at ? '<span>' + esc(n.published_at) + '</span>' : "";
    el.innerHTML =
      '<div class="card__media">' + channelMedia(n, shim) +
        '<div class="card__tags"><span class="card__tags-l">' + cat + '</span></div>' +
      '</div>' +
      '<div class="card__body">' +
        '<h2 class="card__title">' + esc(title) + '</h2>' +
        (summary ? '<p class="card__summary">' + esc(summary) + '</p>' : "") +
        '<div class="card__meta"><span class="m-org">' + esc(n.source || "") + '</span>' + date + '</div>' +
        viaChip(n) +
        '<div class="card__foot">' +
          '<button class="btn btn--ghost" type="button" data-act="pagetrans" data-url="' + esc(F.safeUrl(n.url)) + '">' + AP.t("transQuick") + '</button>' +
          '<a class="btn btn--dark" href="' + esc(F.safeUrl(n.url)) + '" target="_blank" rel="noopener" data-act="visit">' + AP.t("news_readmore") + ' ↗</a>' +
        '</div>' +
      '</div>';
    return el;
  };
  // ---------- 招聘卡片(点击→申请/官网) ----------
  AP.renderJobCard = function (j) {
    var title = F.loc(j, "title") || j.title || "";
    var summary = F.loc(j, "summary") || j.summary || "";
    var org = F.loc(j, "org") || j.org || "";
    var shim = { id: j.id, category: "jobs", title_zh: title, org_zh: org };
    var el = document.createElement("article");
    el.className = "card card--link";
    var apply = F.safeUrl(j.apply_url);
    el.setAttribute("data-url", apply);   // setAttribute 自带转义,勿再 esc
    var place = [j.city, j.country].filter(Boolean).join(" · ");
    var badges = "";
    if (j.employment_type) badges += '<span class="badge badge--fee">' + esc(j.employment_type) + '</span>';
    if (j.salary) badges += '<span class="badge badge--fund">' + esc(j.salary) + '</span>';
    el.innerHTML =
      '<div class="card__media">' + channelMedia(j, shim) +
        '<div class="card__tags"><span class="card__tags-l"><span class="cat-tag" data-cat="jobs">' + esc(AP.t("ch_jobs")) + '</span></span></div>' +
      '</div>' +
      '<div class="card__body">' +
        '<h2 class="card__title">' + esc(title) + '</h2>' +
        '<div class="card__meta"><span class="m-org">' + esc(org) + '</span>' + (place ? '<span>' + esc(place) + '</span>' : "") + '</div>' +
        (badges ? '<div class="badges">' + badges + '</div>' : "") +
        (j.deadline ? '<div class="card__deadline due-normal">' + esc(AP.t("job_deadline")) + " " + esc(j.deadline) + '</div>' : "") +
        (summary ? '<p class="card__summary">' + esc(summary) + '</p>' : "") +
        viaChip(j) +
        '<div class="card__foot">' +
          '<button class="btn btn--ghost" type="button" data-act="pagetrans" data-url="' + esc(apply) + '">' + AP.t("transQuick") + '</button>' +
          '<a class="btn btn--dark" href="' + esc(apply) + '" target="_blank" rel="noopener" data-act="visit">' + AP.t("job_apply") + ' ↗</a>' +
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
    var en = AP.lang === "en";
    var age = en ? (e.age_limit_en || e.age_limit) : e.age_limit;
    var nat = en ? (e.nationality_en || e.nationality) : e.nationality;
    var parts = [];
    if (e.students_ok === true) parts.push(AP.t("students") + ": " + AP.t("yes"));
    else if (e.students_ok === false) parts.push(AP.t("students") + ": " + AP.t("no"));
    if (age) parts.push(AP.t("age") + ": " + age);
    if (nat) parts.push(AP.t("nationality") + ": " + nat);
    if (!parts.length) return muted(AP.t("notStated"));
    return parts.map(esc).join("<br>");
  }

  AP.renderDetail = function (o) {
    var dl = F.deadline(o);
    var en = AP.lang === "en";
    var place = [F.loc(o, "city"), F.loc(o, "country")].filter(Boolean).join(" · ");
    // 学科:EN 模式用等长对齐的 disciplines_en,缺则回退原文
    var discArr = (o.disciplines && o.disciplines.length) ? o.disciplines : null;
    var discShow = (en && discArr && o.disciplines_en && o.disciplines_en.length === discArr.length) ? o.disciplines_en : discArr;
    var disc = discShow ? discShow.map(esc).join(en ? ", " : "、") : muted(AP.t("notStated"));
    var alert = o.trust === "auto"
      ? '<div class="d-alert">' + ICON.circle + '<span>' + esc(AP.t("autoNotice")) + '</span></div>'
      : '';
    var fundHtml = fundLine(AP.t("stipend"), (o.funding || {}).stipend) + "　" +
                   fundLine(AP.t("housing"), (o.funding || {}).housing) + "　" +
                   fundLine(AP.t("travel"), (o.funding || {}).travel);
    var dnoteTxt = en ? (o.deadline_note_en || o.deadline_note) : o.deadline_note;
    var dnote = dnoteTxt ? ' <span class="muted">(' + esc(dnoteTxt) + ')</span>' : '';

    var coverUrl = F.coverSrc(o);
    var cover = coverUrl
      ? '<img class="d-cover" src="' + esc(coverUrl) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">'
      : '<div class="d-cover d-cover--art">' + F.coverArt(o) + '</div>';
    var prov = F.provenance(o);
    var official = F.safeUrl(F.officialUrl(o));
    var srcUrl = F.safeUrl(o.url);
    var provNote = '<div class="d-provenance src-chip--' + prov.kind + '">' + esc(prov.detail) + '</div>';
    // EN 模式且该条含机翻字段 → 如实标注(反误导红线:不冒充官方英文)
    var mtNote = (en && hasMt(o)) ? '<p class="d-mt-note">' + esc(AP.t("mtNote")) + '</p>' : '';
    var summaryTxt = F.loc(o, "summary");
    var summaryHtml = summaryTxt ? '<p class="d-summary">' + esc(summaryTxt) + '</p>' : '';
    var srcVal = '<span class="src-chip src-chip--' + prov.kind + '">' + esc(prov.label) + '</span>' +
      (srcUrl ? ' <a href="' + esc(srcUrl) + '" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(o.domain || AP.t("visit")) + '</a>' : '');
    var html =
      cover +
      '<div class="d-head">' +
        // 分类章底色走 CSS 的 data-cat 规则(--tag-*),随主题正确换肤;不再内联硬编码色
        '<span class="d-cat" data-cat="' + esc(o.category) + '">' + esc(AP.tt[AP.lang].cat[o.category] || o.category) + '</span>' +
        '<h1 class="d-title" id="detailTitle">' + esc(F.loc(o, "title")) + '</h1>' +
        (function () { var alt = en ? o.title_zh : (mtHas(o, "title") ? null : o.title_en);
          return (alt && alt !== F.loc(o, "title")) ? '<div class="d-title-en">' + esc(alt) + '</div>' : ''; })() +
      '</div>' +
      // 主操作(复制链接/前往官网)上提到标题正下方:一进详情就够得着,不用滚到底
      '<div class="d-actions d-actions--top">' +
        '<button class="btn btn--ghost" data-act="copy" data-id="' + esc(o.id) + '" type="button">' + AP.t("copyLink") + '</button>' +
        (official
          ? '<a class="btn btn--dark" data-gate="official" href="' + esc(official) + '" target="_blank" rel="noopener">' + AP.t("gotoSite") + '</a>'
          : '<button class="btn btn--ghost" type="button" disabled aria-disabled="true">' + AP.t("noOfficial") + '</button>') +
      '</div>' +
      '<div>' + trustBadge(o) + '</div>' +
      alert +
      provNote +
      mtNote +
      summaryHtml +
      // 简介下的「详情」小按钮:弹出官网完整介绍(实时抓官网正文,跟随界面语言翻译)
      (official
        ? '<div class="d-morewrap"><button class="btn btn--ghost d-more-btn" data-act="pagetrans" data-url="' + esc(official) + '" type="button">' + esc(AP.t("detailMore")) + ' ▸</button></div>'
        : '') +
      '<div class="d-fields">' +
        row(AP.t("dOrg"), esc(F.loc(o, "org")) || muted(AP.t("notStated"))) +
        row(AP.t("dPlace"), place ? esc(place) : muted(AP.t("notStated"))) +
        row(AP.t("dDeadline"), '<span class="' + dl.cls + '">' + esc(dl.text) + '</span>' + dnote) +
        (F.predictLabel(o) ? row(AP.t("dPredict"), '<span class="d-predict">' + esc(F.predictLabel(o)) + '</span>') : '') +
        row(AP.t("dApplyFee"), feeVal(o.apply_fee, false)) +
        row(AP.t("dPartFee"), feeVal(o.participation_fee, true)) +
        row(AP.t("dFunding"), fundHtml) +
        row(AP.t("dEligibility"), eligVal(o)) +
        row(AP.t("dDisc"), disc) +
        row(AP.t("dUrl"), official ? '<a href="' + esc(official) + '" data-gate="official" target="_blank" rel="noopener" style="color:var(--c-residency);text-decoration:underline">' + esc(AP.t("visit")) + '</a>' + (o.official_url ? ' <span class="muted">(' + esc(AP.t("officialLocated")) + ')</span>' : '') : muted(AP.t("notStated"))) +
        row(AP.t("dSource"), srcVal) +
        row(AP.t("dSeen"), esc(o.last_seen) || muted(AP.t("notStated"))) +
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
