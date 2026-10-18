# BuildNoticer

GitHub Actions build'lari tugaganda Telegram botga xabar yuboradigan Cloudflare Worker.
Butun profildagi (private ham) repo'larni kuzatadi, muvaffaqiyatli build'da artifact'ni (50 MB gacha) yuboradi.

## Ulash

1. Cloudflare'da Worker yarating va `worker.js` ni joylang.
2. `STATE` nomli KV namespace yarating va Worker'ga shu nom bilan ulang.
3. Secret'lar: `GITHUB_TOKEN` (fine-grained, All repositories, Actions: Read + Metadata: Read), `BOT_TOKEN`, `CHAT_ID`.
4. Cron trigger: `*/3 * * * *`.
5. Botga avval `/start` yozing.

Ixtiyoriy: `SUBREQUEST_LIMIT` (Workers Paid rejasida `900`), `TRIGGER_KEY` (qo'lda tekshirish: `/?key=...`).

## Cheklovlar

- Telegram bot 50 MB dan katta faylni yubora olmaydi, o'rniga havola yuboriladi.
- Bepul rejada bir tekshiruvda 30 ta repo ko'riladi, qolganlari navbat bilan aylanadi.

Token va secret'larni hech qachon repo'ga yozmang.
