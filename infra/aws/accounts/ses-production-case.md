# SES production access: the case reply

AWS answers a production-access request with a form letter asking how often
we send, how recipient lists are maintained, how bounces, complaints, and
unsubscribes are handled, and for sample content. This is the answer, kept
current with the stack so a re-request in this or another region is a paste.
Reply on the case in the AWS Support Center; the notification address cannot
receive mail.

---

Clankie (https://clankie.bot) is agent software that people run on their own
Mac. Amazon SES carries exactly one kind of message for it: the one-time
sign-in code that Amazon Cognito (passwordless EMAIL_OTP, user pool
`clankie-accounts`) sends when a person enrolls their Mac for remote access
from the Clankie iPhone app. There is no marketing, newsletter, notification,
or bulk mail, and no other sender in this account uses SES.

**Identity.** Mail is sent from `no-reply@clankie.bot` under the verified
domain identity `clankie.bot` with Easy DKIM enabled (status SUCCESS) and the
DKIM CNAMEs published at our DNS provider.

**Frequency and volume.** Every message is requested by its recipient: the
person types their own email address into Clankie on their Mac and Cognito
sends one six-digit code to it. A person signs in about once per Mac and then
holds a rotating refresh token for up to 90 days, so a returning user rarely
receives a second code. We expect well under 100 messages per day during the
invited beta and Apple TestFlight review, and a few hundred per day at most
after the public release.

**Recipient lists.** There is no list. The user pool is invite-only: an
operator creates each account with the address the person asked us to use,
and the pool rejects sign-in for any other address. We never purchase, rent,
scrape, or import addresses, and a code is only ever sent to the address the
recipient just typed in.

**Bounces and complaints.** Every send from the domain rides the SES
configuration set `clankie-accounts-mail`, whose event destination publishes
BOUNCE, COMPLAINT, and REJECT events to an SNS topic that emails the operator
in real time. The operator disables the corresponding Cognito user
(`admin-disable-user`); a disabled user cannot request another code, so the
address receives no further mail. Because each message is user-initiated and
single-purpose, we expect bounces to be limited to typos and complaints to be
near zero; either kind ends that address's mail immediately. A CloudWatch
alarm on the account's hourly `Send` metric (threshold 200) notifies the
same topic so an abnormal loop is caught within the hour.

**Unsubscribe.** Transactional sign-in codes carry no subscription. Anyone
who no longer wants mail from us stops using remote access, or asks the
operator through https://github.com/Volpestyle/clankie/issues or
https://clankie.bot/support/ to disable the account, which also ends the
mail. Our privacy policy at https://clankie.bot/privacy/ describes this.

**Sample message** (Cognito's verification template, plain text):

> Subject: Your Clankie sign-in code
>
> Your Clankie sign-in code is 123456. It expires in a few minutes. If you did not request it, you can ignore this message.

Thank you.
