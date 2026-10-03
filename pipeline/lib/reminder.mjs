// reminder.mjs —— 每周投递材料提醒(路线图 35 项,v1.30.0)。
//
// 反幻觉红线在提醒里的落法:与周报同一条纪律 —— 选条与文案全部由【程序】完成,零 AI 调用。
//   条件:用户已收藏的机会 + 未来 30 天内截止(deadline 是规范的 YYYY-MM-DD 字符串);
//   分档:≤7 天截止标"紧急";条目事实(标题/机构/城市/截止日)逐字取自站内已校验入库的数据。
//
// 只认规范 `YYYY-MM-DD` 的 deadline:招聘频道的 deadline 常有"招满为止(滚动招聘)"这类自由文本,
// 无法可靠解析,一律不参与提醒(宁可漏,不可错报截止日)。

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function addDaysISO(iso, n) { return new Date(Date.parse(iso + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10); }

// 从"已解析收藏"里挑出临近截止的机会。items 形如 [{ key, channel, item }](见 server.mjs resolveFavorites)。
// today 传规范 YYYY-MM-DD(北京时间当日)。窗口 (today, today+days],紧急 = (today, today+urgentDays]。
export function dueReminders(items, today, { days = 30, urgentDays = 7 } = {}) {
  const end = addDaysISO(today, days), urgentEnd = addDaysISO(today, urgentDays);
  const out = [];
  for (const x of (items || [])) {
    if (!x || x.channel !== "opportunities") continue;
    const o = x.item || {};
    const dl = String(o.deadline || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dl)) continue;      // 非规范日期(滚动招聘等)不参与
    if (dl < today || dl > end) continue;               // 已截止 / 超出 30 天窗口
    out.push({
      key: x.key, oid: o.id,
      title: o.title_zh || o.title_en || "(无标题)",
      org: o.org_zh || o.org_en || "",
      city: o.city_zh || o.city_en || "", country: o.country_zh || o.country_en || "",
      deadline: dl, urgent: dl <= urgentEnd
    });
  }
  // 截止近的在前(紧急自然排在前面,无需二次分档)
  out.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return out;
}

function linkOf(it, siteUrl) { return siteUrl + "/#/o/" + encodeURIComponent(it.oid); }
function metaOf(it) { return [it.org, [it.city, it.country].filter(Boolean).join(" "), "截止 " + it.deadline].filter(Boolean).join(" · "); }

export function renderReminderHtml(list, { siteUrl, unsubUrl, nickname }) {
  const urgentN = list.filter(x => x.urgent).length;
  const rows = list.map(it =>
    '<div style="margin:0 0 12px;padding:10px 12px;border:1px solid ' + (it.urgent ? "#e6c9a8" : "#e8e4dc") + ';border-radius:8px">' +
      '<a href="' + esc(linkOf(it, siteUrl)) + '" style="font-size:14px;font-weight:600;color:#1b1a18;text-decoration:none">' +
        (it.urgent ? '<span style="color:#b4531f">[紧急]</span> ' : "") + esc(it.title) + "</a>" +
      '<div style="font-size:12px;color:#8a847c;margin-top:3px">' + esc(metaOf(it)) + "</div>" +
    "</div>"
  ).join("");
  return (
    '<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background:#f7f6f2;color:#1b1a18">' +
      '<div style="font-size:12px;letter-spacing:.14em;color:#8a847c">ARTPORTAL</div>' +
      '<h1 style="font-size:19px;margin:8px 0 2px">投递材料提醒</h1>' +
      '<div style="font-size:12px;color:#8a847c">' + esc(nickname || "") + ' · 本周有 ' + list.length + ' 个收藏的机会临近截止' + (urgentN ? ",其中 " + urgentN + " 个一周内截止" : "") + "</div>" +
      '<div style="margin:16px 0 0">' + rows + "</div>" +
      '<hr style="border:none;border-top:1px solid #e8e4dc;margin:24px 0 12px" />' +
      '<p style="font-size:11px;color:#8a847c;line-height:1.7">你收到本邮件是因为开启了 ArtPortal 投递材料提醒。' +
        '<a href="' + esc(unsubUrl) + '" style="color:#8a847c">退订提醒</a> · ' +
        '<a href="' + esc(siteUrl) + '" style="color:#8a847c">访问 ArtPortal</a></p>' +
    "</div>"
  );
}

export function renderReminderText(list, { siteUrl, unsubUrl, nickname }) {
  const urgentN = list.filter(x => x.urgent).length;
  const lines = ["投递材料提醒", (nickname || "") + " · 本周有 " + list.length + " 个收藏的机会临近截止" + (urgentN ? ",其中 " + urgentN + " 个一周内截止" : ""), ""];
  for (const it of list) {
    lines.push("· " + (it.urgent ? "[紧急] " : "") + it.title + "(" + metaOf(it) + ")");
    lines.push("  " + linkOf(it, siteUrl));
  }
  lines.push("", "退订提醒:" + unsubUrl);
  return lines.join("\n");
}