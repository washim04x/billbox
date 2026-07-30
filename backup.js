const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_FILE_PATH = path.resolve(__dirname, 'billbox.db');
const TOKEN_PATH = path.resolve(__dirname, 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

function getAuthUrl() {
    const oAuth2Client = getOAuth2Client();
    return oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent' // Force to get refresh token
    });
}

async function handleCallback(code) {
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    // Save the token to disk for later program executions
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    return tokens;
}

function isAuthorized() {
    return fs.existsSync(TOKEN_PATH);
}

async function uploadBackup() {
    console.log('[Backup] Starting backup process to Google Drive...');

    if (!fs.existsSync(DB_FILE_PATH)) {
        console.error('[Backup] Database file not found:', DB_FILE_PATH);
        return;
    }

    if (!isAuthorized()) {
        console.error('[Backup] Not authorized. User needs to connect Google Drive first.');
        return;
    }

    const oAuth2Client = getOAuth2Client();
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(tokens);

    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    try {
        // 1. Find or create the "BillBox Backups" folder
        const folderName = 'BillBox Backups';
        let folderId = null;

        const res = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files.length > 0) {
            folderId = res.data.files[0].id;
        } else {
            // Create folder
            const folderMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            };
            const folder = await drive.files.create({
                resource: folderMetadata,
                fields: 'id'
            });
            folderId = folder.data.id;
            console.log(`[Backup] Created new folder '${folderName}' with ID: ${folderId}`);
        }

        // 2. Upload the file
        const fileMetadata = {
            name: `billbox_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
            parents: [folderId]
        };
        const media = {
            mimeType: 'application/x-sqlite3',
            body: fs.createReadStream(DB_FILE_PATH)
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        });

        console.log('[Backup] Backup successful! File ID:', file.data.id);
        return { success: true, fileId: file.data.id };
    } catch (err) {
        console.error('[Backup] Backup failed:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    getAuthUrl,
    handleCallback,
    isAuthorized,
    uploadBackup
};
