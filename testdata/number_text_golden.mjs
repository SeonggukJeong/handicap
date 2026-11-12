// 모니터 숫자 글자 골든 픽스처 — JavaScript `String(number)`(V8)의 글자.
// 만들기: node testdata/number_text_golden.mjs > testdata/number_text_golden.json
// 읽는 곳: crates/controller/src/monitor/number.rs 테스트(`float_text`가 같은 글자를 내는지).
// 줄 모양: ["f64 비트(16진 16자)", "기대 글자"]. 난수는 고정 씨앗이라 다시 만들어도 같은 파일이다.
let s = 0x9e3779b97f4a7c15n;
const M = (1n << 64n) - 1n;
const next = () => {
  s ^= s >> 12n;
  s ^= (s << 25n) & M;
  s ^= s >> 27n;
  return (s * 0x2545f4914f6cdd1dn) & M;
};
const view = new DataView(new ArrayBuffer(8));
const rows = [];
const seen = new Set();
const pushBits = (bits) => {
  view.setBigUint64(0, bits);
  const v = view.getFloat64(0);
  if (!Number.isFinite(v)) return;
  const hex = bits.toString(16).padStart(16, "0");
  if (seen.has(hex)) return;
  seen.add(hex);
  rows.push([hex, String(v)]);
};
const pushNum = (v) => {
  view.setFloat64(0, v);
  pushBits(view.getBigUint64(0));
};
// 1) 경계값 — 표기 갈래가 바뀌는 자리와 양 끝.
for (const v of [
  0, -0, 1, -1, 100, 0.5, 0.1, 0.3, 1 / 3, -1.5, 100.25, 1e5, 123456.789,
  1e20, 1e21, 1e22, 123456789012345680000, 999999999999999900000, -1e21,
  1e-6, 1e-7, 1.5e-7, 0.000001234, -1e-7, 1.5e-6,
  2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 64, 1e300, 2.5e-300, 1.5e-300, 4.5e250,
  972.0979928970337, 1658206780088562.3, 5e-324, 2.2250738585072014e-308,
  1.7976931348623157e308, -1.7976931348623157e308,
]) pushNum(v);
// 2) 임의 비트 500.
for (let i = 0; i < 500; i++) pushBits(next());
// 3) 동률 구간 500 — 2^50~2^51은 간격이 0.25라 x.25·x.75에서 가장 짧은 자릿수가 둘이고 값이 그 가운데다.
for (let i = 0; i < 500; i++) {
  const k = 2 ** 50 + Number(next() % (1n << 50n));
  pushNum(k + (i % 2 === 0 ? 0.25 : 0.75));
}
// 4) 짧은 소수 300 — 사람이 적는 값(자릿수 8 이하 × 10^-30..29).
for (let i = 0; i < 300; i++) {
  const e = Number(next() % 60n) - 30;
  pushNum(Number(`${next() % 100000000n}e${e}`));
}
process.stdout.write("[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
