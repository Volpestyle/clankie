# SES production access: the case reply

AWS answers a production-access request with a form letter asking how often
we send, how recipient lists are maintained, how bounces, complaints, and
unsubscribes are handled, and for sample content. This is the answer, kept
current with the stack so a re-request in this or another region is a paste.
Review this text before replying on existing case `178831379600291` in the
AWS Support Center; the notification address cannot receive mail. The case
is closed after no response, and requires reopening. This draft is not sent.

Operator alarm delivery is a release prerequisite. The intended subscription
is email `volpestyle@gmail.com` on
`arn:aws:sns:us-east-1:842434829012:clankie-accounts-alarms`.
The approved subscription request is created and has `PendingConfirmation=true`.
James must follow the AWS SNS confirmation email link before notifications can
arrive. A returned subscription ARN alone does not prove confirmation. The
case reply is approved and prepared below.

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
configuration set `clankie-accounts-mail`, whose enabled event destination
publishes BOUNCE, COMPLAINT, and REJECT events to an SNS topic. SES account-level
suppression is enabled for BOUNCE and COMPLAINT. The SNS operator email subscription is created but awaiting confirmation;
confirming it is an outstanding prerequisite, and we will keep external testing gated until it is
confirmed. The operator's handling procedure is to disable the corresponding Cognito user
(`admin-disable-user`); a disabled user cannot request another code, so the
address receives no further mail. Because each message is user-initiated and
single-purpose, we expect bounces to be limited to typos and complaints to be
near zero. A CloudWatch
alarm on the account's hourly `Send` metric (threshold 200) notifies the
same topic; it has actions enabled, but email delivery also depends on that
subscription being confirmed.

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
