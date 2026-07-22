/* IP 属地离线解析(自托管 ip2region_v4.xdb,零外部接口——延续"外链必自托管"铁律)。
   合规展示口径(与主流平台一致):境内=省级(直辖市=市),境外=国家。
   xdb 结构:头 256B;向量索引 256*256*8(startPtr/endPtr,uint32 LE);
   段索引每条 14B = sip(4)+eip(4)+dataLen(2)+dataPtr(4);内容 UTF-8 "国家|区域|省|市|ISP"。 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let BUF = null;
try { BUF = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ip2region.xdb")); }
catch (e) { BUF = null; }   // 库缺失时全部返回 null(功能降级,不崩)

const HEADER = 256, SEG = 14;

function ip4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
  if (!m) return null;
  const a = +m[1], b = +m[2], c = +m[3], d = +m[4];
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

export function ipSearch(ip) {
  if (!BUF) return null;
  ip = String(ip || "").replace(/^::ffff:/i, "");   // IPv4-mapped IPv6
  const v = ip4ToInt(ip);
  if (v == null) return null;
  const a = v >>> 24, b = (v >>> 16) & 255;
  // 内网/保留段不解析
  if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  const idx = HEADER + (a * 256 + b) * 8;
  const sPtr = BUF.readUInt32LE(idx), ePtr = BUF.readUInt32LE(idx + 4);
  if (!sPtr || ePtr < sPtr) return null;
  let l = 0, h = ((ePtr - sPtr) / SEG) | 0, hit = null;
  while (l <= h) {
    const m2 = (l + h) >> 1, p = sPtr + m2 * SEG;
    const sip = BUF.readUInt32LE(p), eip = BUF.readUInt32LE(p + 4);
    if (v < sip) h = m2 - 1;
    else if (v > eip) l = m2 + 1;
    else { hit = p; break; }
  }
  if (hit == null) return null;
  const len = BUF.readUInt16LE(hit + 8), ptr = BUF.readUInt32LE(hit + 10);
  try { return BUF.toString("utf8", ptr, ptr + len); } catch (e) { return null; }
}

const strip = s => String(s || "").replace(/(维吾尔自治区|壮族自治区|回族自治区|特别行政区|自治区|省|市)$/, "");

// v4 字段布局:"国家|省|市|ISP|国家码"(缺失为 0)
// -> {country, province, city, disp} | null;disp=展示口径(境内省/直辖市,境外国家)
export function ipRegion(ip) {
  const raw = ipSearch(ip);
  if (!raw) return null;
  const p = raw.split("|").map(x => (x === "0" ? "" : x));
  const country = p[0] || "", province = strip(p[1] || ""), city = strip(p[2] || "");
  if (!country) return null;
  const disp = (country === "中国") ? (province || city || "中国") : country;
  return { country, province, city, disp };
}
