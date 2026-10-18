# BuildNoticer

GitHub Actions build'lari haqida Telegram botga xabar yuboradigan Cloudflare Worker.
Butun profildagi (private ham) repo'larni kuzatadi.

## Nimalar haqida xabar beradi

- 🚀 build boshlanganda
- ✅ muvaffaqiyatli tugaganda (artifact bo'lsa, 50 MB gacha faylni ham yuboradi)
- ❌ yiqilganda (`failure`, `timed_out`, `startup_failure`)
- 🚫 bekor qilinganda

Botga `/start` yoki `/status` yozsangiz, hozir faol build'lar ro'yxatini yuboradi.
Worker har 1 daqiqada tekshiradi, shuning uchun xabar ~1 daqiqagacha kechikishi mumkin.

## Ulash

1. Cloudflare → Workers & Pages → Create → Import a repository: shu repo, Worker nomi `buildnoticer`.
2. Cloudflare → KV namespace yarating va `wrangler.toml` dagi `id` ni almashtiring.
3. Worker → Settings → Variables and Secrets (hammasi **Secret** turida):
   `GITHUB_TOKEN` (fine-grained, All repositories, Actions: Read + Metadata: Read), `BOT_TOKEN`, `CHAT_ID`,
   `TRIGGER_KEY` (faqat harf, raqam, `_` va `-`).
4. Deploy tugagach, bir marta oching: `https://<worker>.workers.dev/setup?key=<TRIGGER_KEY>`
   (Telegram webhook'ni o'rnatadi, javobda `"ok":true` chiqadi).
5. Botga `/start` yozing.

Qo'lda tekshirish: `/?key=<TRIGGER_KEY>`.

Ixtiyoriy o'zgaruvchilar:
- `START_AFTER_MIN` — boshlanish xabarini build shuncha daqiqa ishlagandan keyin yuborish (masalan `2`).
- `SUBREQUEST_LIMIT` — Workers Paid rejasida `900`.

## Cheklovlar

- Telegram bot 50 MB dan katta faylni yubora olmaydi, o'rniga havola yuboriladi.
- Bepul rejada bir tekshiruvda ~30 ta repo ko'riladi: yaqinda push qilinganlari har safar, qolganlari navbat bilan.
- Bot faqat `CHAT_ID` dagi chatga javob beradi.

Token va secret'larni hech qachon repo'ga yozmang.
