// _tmp-probe42.mjs —— 更多平台探测(美术馆/机构列表)
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["cs-res", "https://curatorspace.com/opportunities/residencies", "curatorspace.com"],
  ["cs-awards", "https://curatorspace.com/opportunities/awards", "curatorspace.com"],
  ["cs-commissions", "https://curatorspace.com/opportunities/commissions", "curatorspace.com"],
  ["cs-competitions", "https://curatorspace.com/opportunities/competitions", "curatorspace.com"],
  ["cs-opps-all", "https://curatorspace.com/opportunities", "curatorspace.com"],
  ["artconnect-residencies", "https://www.artconnect.com/opportunities/residencies", "artconnect.com"],
  ["artconnect-opencalls", "https://www.artconnect.com/opportunities/opencalls", "artconnect.com"],
  ["artconnect-cfe", "https://www.artconnect.com/opportunities/calls-for-entry", "artconnect.com"],
  ["artconnect-awards", "https://www.artconnect.com/opportunities/awards", "artconnect.com"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
