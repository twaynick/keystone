# Signing Keystone's installer

Unsigned, Windows says **Unknown publisher** and SmartScreen warns before
installing. Signed, it shows your name as the publisher, and the warning fades
as SmartScreen builds a reputation for that name across installs. The warning
doesn't disappear on day one: since 2024 no certificate, EV included, skips that.

Keystone signs with **Azure Artifact Signing** (formerly Trusted Signing):

- **$9.99 a month** (Basic tier, 5,000 signatures a month; each release uses a handful).
- Individuals in the **US and Canada** can use it. Organizations can in more countries.
- There's no USB token or certificate file to look after. GitHub signs during the release build.
- The publisher Windows shows is **your legal name**, as on your ID. A company name needs a registered business.

The release workflow already knows how to sign. It switches on by itself
once the settings below are in the repo. Until then it builds unsigned, exactly as before.

Do Part 1 on a PC: the Azure portal is hard work on a phone.

## Part 1: Azure (about 30 minutes, then 1 to 20 business days of waiting)

1. **Make an Azure account** at <https://azure.microsoft.com> (pay-as-you-go; it asks for a card).
2. **Turn on the service.** In the portal, open **Subscriptions**, your subscription, **Resource providers**,
   search **Microsoft.CodeSigning**, then **Register**.
3. **Create the signing account.** Search the portal for **Artifact Signing Accounts**, then **Create**:
   - Resource group: new, for example `keystone-signing`
   - Name: for example `keystonesigning` (3 to 24 letters and numbers, unique across Azure)
   - Region: **East US** (or the nearest US region)
   - Pricing tier: **Basic**

   Note the region's **endpoint**. East US is `https://eus.codesigning.azure.net`; others are
   listed in Microsoft's quickstart (Central US `cus`, West US 2 `wus2`, and so on).
4. **Let yourself request identity validation.** In the signing account, open **Access control (IAM)**,
   **Add role assignment**, role **Artifact Signing Identity Verifier**, and assign it to yourself.
   (If something says you need a Microsoft Entra ID P2 license for this, you don't: the IAM screen works on any account.)
5. **Prove who you are.** In the signing account, **Identity validation**, **New identity**, **Public**, **Individual**.
   Type your legal name **exactly** as on your government ID and upload what it asks for.
   Microsoft sends a verification email: open the link within **7 days**. Check spam, because missed emails are
   the usual reason validation stalls. It takes 1 to 20 business days. Wait for **Completed**.
6. **Make the certificate profile.** In the signing account, **Certificate profiles**, **Create**, **Public Trust**.
   Name it, for example `keystone`, and pick your validated identity. Open the new profile and copy the
   **Subject** name (CN=…): the part after `CN=` is your **publisher name**.
7. **Make a login for GitHub.** Search the portal for **App registrations**, **New registration**, name
   `keystone-github`, then **Register**. On its overview, copy the **Application (client) ID** and the
   **Directory (tenant) ID**. Then open **Certificates & secrets**, **New client secret**, and pick 24 months.
   Copy the **Value** now, because it's only shown once. Put a reminder in your calendar for when it expires.
8. **Let that login sign.** Go back to the signing account, then **Certificate profiles**, your profile,
   **Access control (IAM)**, **Add role assignment**. Pick role **Artifact Signing Certificate Profile Signer**
   and member **keystone-github** (search for it; it's an app, not a person).

## Part 2: GitHub (5 minutes; works from a phone browser)

In the repo on github.com, open **Settings**, **Secrets and variables**, **Actions**.

On the **Secrets** tab, add three secrets:

| Name | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID from step 7 |
| `AZURE_CLIENT_ID` | Application (client) ID from step 7 |
| `AZURE_CLIENT_SECRET` | The secret **Value** from step 7 |

On the **Variables** tab, add four variables:

| Name | Example |
|---|---|
| `AZURE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | `keystonesigning`, the **signing account's** name from step 3, not your Azure login |
| `AZURE_SIGNING_PROFILE` | `keystone` |
| `AZURE_SIGNING_PUBLISHER` | Your publisher name from step 6, exactly |

Push the next release tag as usual. In the Actions log, **Check the signature** prints
`Valid, signed by CN=…` for each file. If anything isn't validly signed, the release stops
there instead of publishing.

## What people see afterwards

- Right-click the installer, **Properties**, **Digital Signatures**: your name.
- SmartScreen may still show **Windows protected your PC** for a while, but with **Publisher: your name**.
  **More info**, then **Run anyway** gets past it, the same as now. The warning stops as installs build reputation.
- Antivirus software is wary of anything that reads and writes other programs' memory, which mods do.
  Signing makes false alarms less likely, but it can't promise none.

## If something goes wrong

- **"Code signing is half set up"**: one of the seven settings is missing or misspelled. Names are case-sensitive.
- **403 / Forbidden while signing**: usually `AZURE_SIGNING_ACCOUNT` holds the wrong name (it's the signing
  account's, not your login), or the Signer role (step 8) went to the account rather than the profile, or to the
  wrong member.
- **Signing worked before and suddenly fails to sign in**: the client secret expired. Make a new one (step 7)
  and replace `AZURE_CLIENT_SECRET`.
- **To stop paying**: delete the `keystone-signing` resource group in Azure. Releases already signed stay
  valid, because each signature is timestamped. Then remove the secrets and variables, and builds go back to unsigned.

Sources: Microsoft's [code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options),
[Artifact Signing quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) and
[roles](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles).
