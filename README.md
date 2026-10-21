# BuildNoticer

GitHub Actions build'lari haqida Telegram botga xabar yuboradigan Cloudflare Worker.
Butun profildagi (private ham) repo'larni kuzatadi.

## Nimalar haqida xabar beradi

- 🚀 build boshlanganda
- ✅ muvaffaqiyatli tugaganda (artifact bo'lsa, 50 MB gacha faylni ham yuboradi)
- ❌ yiqilganda (`failure`, `timed_out`, `startup_failure`)
- 🚫 bekor qilinganda

Botga `/start` yoki `/status` yozsangiz, hozir faol build va deploy'lar ro'yxatini yuboradi.
Worker har 1 daqiqada tekshiradi, shuning uchun xabar ~1 daqiqagacha kechikishi mumkin.

## Buyruqlar

Telegramda `/` bosganda menyu chiqadi (cron birinchi ishlaganda o'zi ro'yxatdan o'tkazadi):

- `/status`: faol build va deploy'lar
- `/builds`: faqat GitHub build'lar
- `/deploys`: Render servislarining oxirgi deploy'i
- `/logs servis`: servisning oxirgi deploy build logi (`/logs servis app` — ish logi, oxirgi soat)
- `/help`: buyruqlar ro'yxati

## Render deploy'lar (ixtiyoriy)

`RENDER_API_KEY` qo'yilsa, Render servislaridagi deploy'lar ham kuzatiladi:

- 🚀 deploy boshlanganda
- ✅ `live` bo'lganda
- ❌ `build_failed`, `update_failed`, `pre_deploy_failed`
- 🚫 `canceled`

Kalit: Render → Account Settings → API Keys. Worker'da **Secret** turida `RENDER_API_KEY` qo'shing.
Faqat ayrim servislarni kuzatish uchun `RENDER_SERVICES` o'zgaruvchisi (servis nomi yoki `srv-...` id, vergul bilan).
Kalit qo'yilmasa, Render qismi o'chiq turadi va avvalgidek faqat GitHub kuzatiladi.

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
- Render ham bepul rejadagi 50 so'rov limitidan ulush oladi (bir tekshiruvda ko'pi bilan 8 ta servis), shuning uchun GitHub'dan ko'riladigan repolar ~30 dan ~20 tagacha kamayadi. Workers Paid rejasida (`SUBREQUEST_LIMIT=900`) bunday muammo yo'q.
- Bepul rejada bir tekshiruvda ~30 ta repo ko'riladi: yaqinda push qilinganlari har safar, qolganlari navbat bilan.
- Bot faqat `CHAT_ID` dagi chatga javob beradi.

Token va secret'larni hech qachon repo'ga yozmang.
