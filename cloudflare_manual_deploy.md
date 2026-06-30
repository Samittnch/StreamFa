```md
# StreamFa Manual Deployment Guide for Cloudflare Workers
## No Wrangler, No Terminal

This guide explains how to upload and deploy **StreamFa** manually using the **Cloudflare Dashboard**, without Wrangler or command-line tools.

---

## Requirements

Before starting, make sure you have:

- A Cloudflare account
- Your full Worker code
- A web browser
- If using Telegram features:
  - Telegram Bot Token
  - Telegram Chat ID

---

## Step 1: Log in to Cloudflare

1. Open:
   https://dash.cloudflare.com
2. Log in to your Cloudflare account.

---

## Step 2: Go to Workers

1. In the left menu, open:
   **Workers & Pages**
2. Click:
   **Create application**
3. Choose:
   **Create Worker**
4. Enter a Worker name, for example:

```text
streamfa
```

5. Click **Deploy**
6. After creation, click **Edit code**

---

## Step 3: Replace the Worker Code

1. Inside the Cloudflare editor, delete the default code completely.
2. Paste your full StreamFa Worker code into the editor.
3. Click **Save and Deploy**

> If your project is a single Worker file, this step is enough for the code itself.
> If your code was previously in `src/worker.js`, just paste that file content here.

---

## Step 4: Create a KV Namespace

The project needs KV to store users, sessions, channels, settings, and app data.

### To create KV:
1. In the Cloudflare dashboard, go to:
   **Storage & Databases**
2. Click:
   **KV**
3. Click:
   **Create namespace**
4. Set the namespace name to:

```text
IPTV_KV
```

5. Create it.

---

## Step 5: Bind KV to the Worker

After creating the KV namespace, connect it to your Worker.

1. Open your Worker
2. Go to the:
   **Settings**
   tab
3. Open:
   **Bindings**
4. Click:
   **Add binding**
5. Choose binding type:
   **KV Namespace**
6. Fill the fields like this:

- **Variable name**
```text
IPTV_KV
```

- **KV namespace**
Select the namespace you created

7. Save it.

---

## Step 6: Create an R2 Bucket

The project uses R2 for file uploads, avatars, and stored assets.

### To create R2:
1. In the Cloudflare dashboard, go to:
   **Storage & Databases**
2. Click:
   **R2**
3. Click:
   **Create bucket**
4. Set the bucket name to:

```text
streamfa-files
```

5. Create it.

---

## Step 7: Bind R2 to the Worker

1. Open your Worker
2. Go to:
   **Settings**
3. Open:
   **Bindings**
4. Click:
   **Add binding**
5. Choose binding type:
   **R2 bucket**
6. Fill the fields as follows:

- **Variable name**
```text
IPTV_R2
```

- **R2 bucket**
Select the bucket you created: `streamfa-files`

7. Save it.

---

## Step 8: Add Environment Variables

The project needs several environment variables.

1. Open your Worker
2. Go to:
   **Settings**
3. Open:
   **Variables**
4. Click **Add variable** for each of the following

### Regular variables

#### 1. ADMIN_USERNAME
```text
admin
```

#### 2. TRUST_CODE
```text
IPTV2025VIP
```

#### 3. TRON_ADDRESS
```text
TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Step 9: Add Secrets

Sensitive values such as Telegram tokens should be added as secrets.

In the same **Variables** or **Secrets** section, add:

### 1. TELEGRAM_BOT_TOKEN
Your Telegram bot token

### 2. TELEGRAM_CHAT_ID
Your Telegram chat ID or channel ID

> If you do not use Telegram features, you can leave these out, but Telegram notifications will not work.

---

## Step 10: Save and Deploy Again

After adding bindings and variables:

1. Go back to the **Code** tab
2. Click **Save and Deploy**

This ensures the Worker runs with the latest settings.

---

## Step 11: Open the Worker URL

After deployment, Cloudflare gives you a URL similar to:

```text
https://streamfa.your-subdomain.workers.dev
```

This is your live app URL.

Open it in your browser.

---

## Step 12: Create the Admin Account

The owner/admin role is determined by the `ADMIN_USERNAME` value.

For example, if you set:

```text
ADMIN_USERNAME = admin
```

Then you must sign up on the site using this username:

```text
admin
```

That account will automatically be treated as the main admin/owner account.

---

## Step 13: Open the Admin Panel

After creating the admin account:

- Log in to the site
- Visit:

```text
/admin
```

If everything is configured correctly, the admin panel should open.

---

## Step 14: Recommended Initial Setup

After deployment, it is recommended to:

1. Open `/admin`
2. Create categories
3. Add or import channels
4. Configure payment information
5. Test Telegram notifications
6. Export a backup
7. Check stream health

---

## Step 15: Important Routes

### Home page
```text
/
```

### Admin panel
```text
/admin
```

### Current auth status
```text
/api/auth/me
```

---

## Step 16: If Something Does Not Work

If the app fails after deployment, check the following:

### 1. KV and R2 bindings are connected correctly
They must use these exact variable names:

- `IPTV_KV`
- `IPTV_R2`

### 2. Environment variables are set correctly
Check:

- `ADMIN_USERNAME`
- `TRUST_CODE`
- `TRON_ADDRESS`

### 3. Secrets are added correctly
If using Telegram:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### 4. The full Worker code was pasted and saved
Sometimes only part of the code is pasted, or changes are not saved.

### 5. You redeployed after changes
After editing variables or bindings, click **Save and Deploy** again.

---

## Step 17: Optional GitHub Usage

Even if deployment is manual, it is strongly recommended to store your source code on GitHub.

Suggested repository files:

- `README.md`
- `LICENSE`
- `src/worker.js`
- `CLOUDFLARE_MANUAL_DEPLOY.md`

---

## Step 18: Security Notes

- Do not hardcode Telegram tokens in your Worker code
- Store sensitive values only in Variables / Secrets
- Do not upload private credentials to a public GitHub repository

---

## Step 19: Note About Static Files

If your project works as a single Worker file, manual dashboard deployment is enough.

If your project later includes separate files like:

- `index.html`
- `style.css`
- `app.js`

Then you should consider:
- inlining them into the Worker, or
- moving to **Workers + Assets** or **Cloudflare Pages**

For the current StreamFa Worker-based version, a single Worker is enough if all UI is generated from the Worker code.

---

## Step 20: Quick Summary

### What you need to do:
1. Create a Worker
2. Paste the code
3. Create KV named `IPTV_KV`
4. Bind KV to the Worker
5. Create R2 bucket named `streamfa-files`
6. Bind R2 as `IPTV_R2`
7. Add variables:
   - `ADMIN_USERNAME`
   - `TRUST_CODE`
   - `TRON_ADDRESS`
8. Add secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
9. Click **Save and Deploy**
10. Sign up using the admin username
11. Open `/admin`

