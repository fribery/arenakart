// client/api/ping.js
export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({ ok: true, method: req.method }));
}