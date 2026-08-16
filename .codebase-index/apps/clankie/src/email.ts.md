# apps/clankie/src/email.ts

Implements the connected mailbox port used by captain tools. `createEmailPort()` resolves owner-authored server settings plus brokered credentials, then supports bounded list/read/search/send operations through injectable IMAP and SMTP adapters.

`defaultEmailAdapters()` supplies the production `imapflow`/`nodemailer` transports, and `textBody()` extracts readable text from MIME messages. Missing configuration, credentials, and provider failures become typed refusals.
