/**
 * Classroom — email sender (Google Apps Script)
 * ------------------------------------------------------------------
 * Sends the "forgot password" code from YOUR Gmail account. The Classroom
 * server calls this over HTTPS, so it works on Render's free plan.
 *
 * Setup (once):
 *  1. Open https://script.google.com  -> New project. Name it "Classroom Mailer".
 *  2. Delete everything in Code.gs and paste this whole file.
 *  3. Change SECRET below to your own long random text (letters + numbers).
 *  4. Choose the function "testSend" at the top and click Run.
 *     Allow the permissions (Advanced -> Go to Classroom Mailer -> Allow).
 *     You should get a test email.
 *  5. Deploy -> New deployment -> type: Web app
 *       Execute as: Me
 *       Who has access: Anyone
 *     Deploy, then copy the Web app URL (ends with /exec).
 *  6. On Render -> Environment add:
 *       GAS_MAIL_URL    = that /exec URL
 *       GAS_MAIL_SECRET = the same SECRET as below
 *
 * If you edit this script later: Deploy -> Manage deployments -> edit ->
 * Version: New version -> Deploy (the URL stays the same).
 * Gmail limit for Apps Script: about 100 emails per day.
 */
const SECRET = 'CHANGE-ME-to-a-long-random-secret';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return json_({ ok: false, error: 'Wrong secret' });
    if (!body.to || !body.subject) return json_({ ok: false, error: 'Missing to/subject' });
    MailApp.sendEmail({
      to: body.to,
      subject: body.subject,
      body: body.text || '',
      htmlBody: body.html || undefined,
      name: body.name || 'Classroom'
    });
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, info: 'Classroom mailer is running. The server sends emails with POST.' });
}

function testSend() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Classroom mailer test', 'It works! Emails will be sent from this account.');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
