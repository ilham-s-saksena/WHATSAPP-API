import express from 'express'
import baileys, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fs from 'fs'
import fsPromises from 'fs/promises'
import QRCode from 'qrcode'
import { getLinkPreview } from 'link-preview-js'
import axios from 'axios'

const app = express()
const PORT = 3421
app.use(express.json())

function checkIP(req, res, next) {
    
    const allowedIPs = ['::1', '36.82.179.77', '103.76.120.172']
    const allowedIPsDev = ['::1', '127.0.0.1', '36.82.179.77', '103.76.120.172']
    let ip = req.ip

    if (ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', '')
    }

    if (!allowedIPsDev.includes(ip)) {
        return res.status(403).json({ message: 'Forbidden: IP not allowed. your ip: ' + ip })
    }
    next()
}

let sock = null
let latestQR = null                // string QR (raw)
let isStarting = false             // lock agar tidak double start
const authPath = 'auth_info'       // folder session

// Helper: cek koneksi
const isConnected = () => !!(sock && sock.user)

// Helper: start socket (dengan lock)
async function startSock() {
  if (isStarting) return
  isStarting = true
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const { version } = await fetchLatestBaileysVersion()

    sock = baileys.makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false, // kita handle QR via endpoint
      syncFullHistory: false,
    })

    // simpan kredensial setiap update
    sock.ev.on('creds.update', saveCreds)

    // event koneksi
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        latestQR = qr
        console.log('✅ QR tersedia. Ambil via GET /v1/login')
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const isLoggedOut = statusCode === DisconnectReason.loggedOut
        const shouldReconnect = !isLoggedOut
        console.log('⚠️  Koneksi ditutup. statusCode:', statusCode, 'reconnect?', shouldReconnect)

        if (shouldReconnect) {
          // tunggu sedikit untuk menghindari loop cepat
          setTimeout(() => startSock().catch(console.error), 1000)
        } else {
          // benar-benar logout
          latestQR = null
          sock = null
        }
      }

      if (connection === 'open') {
        latestQR = null
        console.log('✅ Tersambung ke WhatsApp sebagai', sock.user?.id)
      }
    })

    // event pesan (opsional)
    sock.ev.on('messages.upsert', ({ messages }) => {
      console.log('📩 Pesan masuk:', messages?.[0]?.key?.remoteJid, messages?.[0]?.message?.conversation || Object.keys(messages?.[0]?.message || {}))
    })
  } catch (err) {
    console.error('❌ Gagal startSock:', err)
    // jika gagal inisialisasi, kosongkan sock supaya bisa dicoba lagi
    sock = null
    throw err
  } finally {
    isStarting = false
  }
}

// start saat boot
await startSock()

// ====== ROUTES ======

// GET QR / status login
app.get('/v1/login', checkIP, async (req, res) => {
  try {
    // kalau belum ada socket atau belum connected, pastikan sudah dipanggil start
    if (!sock && !isStarting) {
      await startSock()
    }

    if (isConnected()) {
      return res.json({
        status: 'connected',
        user: sock.user, // { id, name? }
        message: 'Sudah terhubung ke WhatsApp',
      })
    }

    if (latestQR) {
      const dataUrl = await QRCode.toDataURL(latestQR, { errorCorrectionLevel: 'M' })
      return res.json({
        status: 'scan_qr',
        qr: dataUrl, // data:image/png;base64,...
        message: 'Silakan scan QR untuk login',
      })
    }

    // belum ada QR, biasanya sebentar lagi muncul
    return res.json({
      status: 'pending',
      message: 'QR belum tersedia. Coba lagi sebentar.',
    })
  } catch (err) {
    console.error('❌ /v1/login error:', err)
    res.status(500).json({ error: 'Gagal menyiapkan login', details: err.message })
  }
})

// LOGOUT bersih
app.get('/v1/logout', checkIP, async (req, res) => {
  try {
    // 1) logout dari sisi Baileys (akan invalidasi session)
    if (sock) {
      try {
        await sock.logout()
      } catch (e) {
        // kalau sudah ter-logout, abaikan
        console.warn('⚠️ sock.logout() warning:', e?.message || e)
      }
      try {
        // tutup koneksi websocket
        await sock.ws?.close()
      } catch {}
    }

    // 2) hapus folder kredensial (aman karena sudah logout)
    if (fs.existsSync(authPath)) {
      await fsPromises.rm(authPath, { recursive: true, force: true })
    }

    // 3) reset state
    sock = null
    latestQR = null

    res.json({ status: 'ok', message: 'Berhasil logout & hapus session' })
  } catch (err) {
    console.error('❌ Gagal logout:', err)
    res.status(500).json({ error: 'Gagal logout', details: err.message })
  }
})

// (Opsional) status ringkas
app.get('/v1/status', checkIP, async (req, res) => {
  const user = sock?.user || {}
  const state = sock?.ws?.readyState === 1 ? 'open' : 'closed'

  res.json({
    connected: isConnected(),
    hasQR: !!latestQR,
    state,
    user: {
      id: user.id || null,
      name: user.name || null,
      phone: user.id ? user.id.split('@')[0] : null,
      platform: user.platform || 'WhatsApp Web',
    },
    battery: sock?.user?.battery ?? sock?.ws?.battery ?? null,
    isCharging: sock?.user?.plugged ?? false,
    lastSync: new Date().toISOString(),
  })
})

app.post('/v1/send-embeded-link-preview', checkIP, async (req, res) => {
  if (!sock) return res.status(500).json({ error: 'WhatsApp belum terhubung' })

  const { number, message, link } = req.body
  if (!number || !message || !link) {
    return res.status(400).json({ error: 'Parameter number, message, dan link wajib diisi' })
  }

  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

  try {
    const preview = await getLinkPreview(link)
    const previewText = `${message}\n\n${link}`

    await sock.sendMessage(jid, {
      text: previewText,
      matchedText: link,
      title: preview.title || "Hello World",
      description: preview.description || "Hello World Descriptions",
      previewType: 0,
    })

    res.json({ status: 'Pesan dengan custom link preview dikirim', to: number })
  } catch (err) {
    console.error('❌ Gagal generate preview:', err)
    res.status(500).json({ error: 'Gagal mengambil data preview atau mengirim pesan' })
  }
})


app.post('/v1/send-contact', checkIP, async (req, res) => {
  if (!sock) return res.status(500).json({ error: 'WhatsApp belum terhubung' })

  const { number, contactPhone, displayName } = req.body
  if (!number || !contactPhone || !displayName) {
    return res.status(400).json({ error: 'Parameter number, contactPhone dan displayName wajib diisi' })
  }

  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

  try {

    const vcard = 'BEGIN:VCARD\n'
            + 'VERSION:3.0\n' 
            + `FN:${displayName}\n`
            + `ORG:${displayName};\n`
            + `TEL;type=CELL;type=VOICE;waid=${contactPhone}:+${contactPhone}\n`
            + 'END:VCARD'

    await sock.sendMessage(jid, {
      contacts: { 
          displayName: `${displayName}`, 
          contacts: [{ vcard }] 
      }
    })

    res.json({ status: 'Contact dikirim ', to: number })
  } catch (err) {
    console.error('❌ Gagal generate preview:', err)
    res.status(500).json({ error: 'Gagal mengambil data preview atau mengirim pesan' })
  }
})

app.post('/v1/group/send', checkIP, async (req, res) => {
  if (!sock) return res.status(500).json({ error: 'WhatsApp belum terhubung' })

  const { number, message, imagelink } = req.body
  const jid = number

  try {
    if (imagelink) {
      const response = await axios.get(imagelink, { responseType: 'arraybuffer', validateStatus: () => true })
      
      // Cek status HTTP
      if (response.status !== 200) {
        await sock.sendMessage(jid, { text: message + "\nGambar tidak ter load" })
        return res.status(400).json({ error: `Gagal mengunduh gambar (${response.status})`, url: imagelink })
      }
  
      const buffer = Buffer.from(response.data, 'binary')
  
      // Kirim pesan gambar
      await sock.sendMessage(jid, { image: buffer, caption: message || '' })
    } else {
      await sock.sendMessage(jid, { text: message })
    }
  
    res.json({ status: '✅ Pesan dikirim', to: number })
  } catch (err) {
    console.error('❌ Error:', err)
    res.status(500).json({ error: 'Gagal mengirim pesan', details: err.message })
  }
})

app.post('/v1/send-image', checkIP, async (req, res) => {
  if (!sock) return res.status(500).json({ error: 'WhatsApp belum terhubung' })

  const { number, message, imagelink } = req.body
  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

  const response = await axios.get(imagelink, { responseType: 'arraybuffer', validateStatus: () => true })
  const buffer = Buffer.from(response.data, 'binary')

  try {
    await sock.sendMessage(jid, { image: buffer, caption: message || '' })
    res.json({ status: 'Pesan dikirim', to: number })
  } catch (err) {
    console.error('❌ Gagal kirim:', err)
    res.status(500).json({ error: 'Gagal mengirim pesan' })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`)
})
