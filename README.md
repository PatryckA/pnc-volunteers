# P&C Volunteer Sign-up

An ad-free replacement for signup.com. Volunteers pick time slots for P&C events without creating an account; they give their name, email and mobile, get a confirmation email with a private link to cancel, and a reminder the day before. Committee members load events and slots through a password-protected admin page.

## How it fits together

| Part | Where it lives | What it does |
|---|---|---|
| Website (`docs/` folder) | GitHub Pages, free | The pages volunteers and admins see |
| API (`worker/worker.js`) | Cloudflare Worker, free | Saves sign-ups, checks spots, sends emails |
| Database (`worker/schema.sql`) | Cloudflare D1, free | Events, slots, sign-ups, email queue |
| Email | Your Microsoft 365 (non-profit) | Sends confirmations and reminders |

Pages in the website:

- `index.html`: list of events needing volunteers (share this link)
- `event.html?id=N`: one event; volunteers tick slots and sign up
- `manage.html?t=...`: private link from the confirmation email to view or cancel
- `admin.html`: committee admin (password)

Everything below can be done in a web browser. No command line needed.

---

## Part 1: GitHub (about 5 minutes)

1. In GitHub, create a new **public** repository called `pnc-volunteers`.
2. Click **Add file > Upload files** and drag in the whole contents of this folder (`docs`, `worker`, `README.md`). Commit.
3. Go to **Settings > Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch **main**, folder **/docs**. Save.
4. After a minute the site is at `https://patrycka.github.io/pnc-volunteers/`. It won't show events yet; that comes after Part 2.

## Part 2: Cloudflare (about 15 minutes)

Create a free account at dash.cloudflare.com if you don't have one.

**Database**

1. Go to **Storage & databases > D1 SQL database > Create**. Name it `pnc-volunteers`.
2. Open the database, go to the **Console** tab, paste the entire contents of `worker/schema-oneline.sql` (the console box only takes one line), and click **Execute**. Check the database's **Overview** shows 5 tables.

**Worker (the API)**

1. Go to **Compute (Workers) > Workers & Pages > Create > Start with Hello World**. Name it `pnc-volunteers-api` and deploy.
2. Click **Edit code**, delete everything, paste the entire contents of `worker/worker.js`, and click **Deploy**.
3. In the worker, open **Bindings > Add binding > D1 database**. Variable name `DB`, database `pnc-volunteers`.
4. Open **Settings > Variables and Secrets** and add:

| Name | Type | Value |
|---|---|---|
| `ADMIN_PASSWORD` | Secret | The committee password |
| `SESSION_SECRET` | Secret | Any long random text (mash the keyboard, 40+ characters) |
| `SITE_URL` | Text | `https://patrycka.github.io/pnc-volunteers` |
| `ALLOWED_ORIGIN` | Text | `https://patrycka.github.io` |
| `ORG_NAME` | Text | Your P&C's name, e.g. `Newington Public School P&C` |
| `EMAIL_MODE` | Text | `log` for now (switch to `graph` after Part 3) |
| `DAILY_EMAIL_LIMIT` | Text | `90` |
| `REMINDER_HOURS` | Text | `24` |

5. Open **Settings > Trigger events > Add > Cron trigger** and enter `5 * * * *` (runs at 5 past every hour to send reminders and queued emails).
6. Copy the worker's address (looks like `https://pnc-volunteers-api.yourname.workers.dev`).

**Connect the website to the worker**

In GitHub, open `docs/assets/config.js`, click the pencil icon, and set:

- `apiUrl` to the worker address from step 6
- `orgName`, `tagline`, `accent` colour, and optional `logo` to suit your school

Commit. Visit `.../pnc-volunteers/admin.html`, log in, and create a test event.

## Part 3: Microsoft 365 email (about 15 minutes, needs an M365 admin)

The worker sends email through Microsoft Graph using an "app registration".

1. **Create a mailbox to send from.** In the Microsoft 365 admin centre, go to **Teams & groups > Shared mailboxes** and add one, e.g. `volunteers@yourtenant.onmicrosoft.com`. Shared mailboxes are free (no licence).
2. **Register the app.** Go to entra.microsoft.com > **App registrations > New registration**. Name: `PnC Volunteer Site`. Account type: *this organisational directory only*. Register.
3. From the app's **Overview**, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. **Certificates & secrets > New client secret**. Choose 24 months. Copy the **Value** straight away (it is only shown once). Put a calendar reminder in for a month before it expires.
5. **API permissions > Add a permission > Microsoft Graph > Application permissions > Mail.Send**. Then click **Grant admin consent**.
6. Back in Cloudflare, add these variables to the worker:

| Name | Type | Value |
|---|---|---|
| `MS_TENANT_ID` | Text | Directory (tenant) ID |
| `MS_CLIENT_ID` | Text | Application (client) ID |
| `MS_CLIENT_SECRET` | Secret | The secret value |
| `MS_SENDER` | Text | The shared mailbox address |

7. Change `EMAIL_MODE` to `graph`. Sign up for your test event with your own email and check the confirmation arrives (look in junk the first time).

**Tighter security (recommended).** Step 5 lets the app send as *any* mailbox in your tenant. To limit it to the volunteers mailbox only, your M365 admin can skip step 5 and instead use Exchange "RBAC for Applications" in Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline
# ObjectId = the Object ID shown under Entra > Enterprise applications > PnC Volunteer Site
New-ServicePrincipal -AppId <client id> -ObjectId <enterprise app object id> -DisplayName "PnC Volunteer Site"
New-ManagementScope -Name "PnC volunteers mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'volunteers@yourtenant.onmicrosoft.com'"
New-ManagementRoleAssignment -App <client id> -Role "Application Mail.Send" -CustomResourceScope "PnC volunteers mailbox"
```

Test after changing it. Microsoft documents this under "Role Based Access Control for Applications in Exchange Online".

### The 100-email daily limit

Microsoft limits `onmicrosoft.com` addresses to **100 external recipients per 24 hours for the whole tenant** (including any other email the P&C sends from onmicrosoft addresses). The site handles this:

- Every email goes into a queue. The site sends up to `DAILY_EMAIL_LIMIT` (default 90, leaving headroom) per rolling 24 hours, then waits.
- Anything over the limit sends automatically in the next hourly run once there's room.
- The admin page shows emails sent today, how many are left, and how many are waiting.

For a big event (say 80 volunteers) reminders may arrive a few hours late. To remove the limit, buy a domain (around $15 to $25 a year), add it to Microsoft 365, create the mailbox on that domain, and update `MS_SENDER` and `DAILY_EMAIL_LIMIT` (e.g. `2000`). No code changes needed.

---

## Using it (for committee members)

**Create an event:** Admin > **+ New event**. Fill in the name, location and description. Add slots one at a time (**+ Add slot** continues straight after the last one), or use **+ Add a run of shifts** for back-to-back shifts like "BBQ 9am to 1pm in 1 hour shifts". Tick **Live** and **Save**. Then **Copy volunteer link** and share it.

**Bring-a-plate events (e.g. staff appreciation lunch):** under **Things to bring**, click **+ Add item** for each category (Main dish, Dessert, Drinks) and set how many are needed. Set the drop-off date, time and place once for the whole event. Parents tick an item, type what they'll bring (required) and tick any dietary info. Everyone can see what's already coming, so you don't get five lasagnes. Add a **Donation link** (e.g. your Square link) to show a "Donate instead" button.

**Re-use last year's event:** open it, click **Duplicate**, choose the new date. All slots move together and the copy starts as a draft.

**See who's coming:** the **Volunteers** tab shows each slot with names, mobiles and emails. **Export CSV** opens in Excel.

**Add or remove someone:** Volunteers tab > **+ Add volunteer** (can over-fill a slot), or **Remove** next to their name.

**Email everyone:** **Email volunteers**, choose everyone or one slot, write the message. Replies go to the event's contact email.

**Rules the site enforces:** a slot can't be deleted while people are signed up to it, and capacity can't go below the number already signed up.

## Privacy

- Other volunteers only see first name and last initial (e.g. "Sarah M.").
- Email and mobile are visible only to admins (admin page and CSV).
- The private cancel link is unique to each sign-up and is never shown publicly.
- Sent-email records are deleted after 60 days. Consider deleting old events at the end of each year (export the CSV first if you need a record).

## Costs

Everything runs on free tiers: GitHub Pages, Cloudflare Workers (100,000 requests a day) and D1 (5 GB), and your existing Microsoft 365 non-profit licence. The only optional cost is a custom domain.

## Changing settings later

| To change | Edit |
|---|---|
| Colours, name, logo, welcome text | `docs/assets/config.js` in GitHub |
| Admin password | `ADMIN_PASSWORD` secret in Cloudflare |
| Reminder timing | `REMINDER_HOURS` in Cloudflare |
| Sending address | `MS_SENDER` in Cloudflare |
| Code updates | Paste the new `worker.js` into the Cloudflare editor; upload new `docs` files in GitHub |
| Database updates | When an update includes a `migration-*.sql` file, paste its last line into the D1 console once, before deploying the new `worker.js` |
