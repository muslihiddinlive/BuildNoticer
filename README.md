# BuildNoticer

GitHub Actions build'lari tugaganda Telegram botga xabar yuboradigan Cloudflare Worker.
Butun profildagi (private ham) repo'larni kuzatadi, muvaffaqiyatli build'da artifact'ni (50 MB gacha) yuboradi.

## Ulash

1. Cloudflare → Workers & Pages → Create → Import a repository: shu repo'ni tanlang, Worker nomi `buildnoticer`.
2. Deploy `wrangler.toml` bo'yicha o'zi ishlaydi: `STATE` KV xotirasi avtomatik yaratiladi va cron (`*/3 * * * *`) o'rnatiladi.
3. Worker → Settings → Variables and Secrets: `GITHUB_TOKEN` (fine-grained, All repositories, Actions: Read + Metadata: Read), `BOT_TOKEN`, `CHAT_ID`.
4. Botga avval `/start` yozing.

Ixtiyoriy: `SUBREQUEST_LIMIT` (Workers Paid rejasida `900`), `TRIGGER_KEY` (qo'lda tekshirish: `/?key=...`).

## Cheklovlar

- Telegram bot 50 MB dan katta faylni yubora olmaydi, o'rniga havola yuboriladi.
- Bepul rejada bir tekshiruvda 30 ta repo ko'riladi, qolganlari navbat bilan aylanadi.

Token va secret'larni hech qachon repo'ga yozmang.
