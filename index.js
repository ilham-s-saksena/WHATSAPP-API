import express from 'express'
import baileys, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import fs from 'fs'
import QRCode from 'qrcode'

const app = express()
const PORT = 3000
app.use(express.json())

function checkIP(req, res, next) {
    const allowedIPs = ['::1', '127.0.0.1', '192.168.1.100', '36.82.179.77', '103.76.120.172']
    let ip = req.ip

    // Handle IPv6 mapped IPv4
    if (ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', '')
    }

    if (!allowedIPs.includes(ip)) {
        return res.status(403).json({ message: 'Forbidden: IP not allowed. your ip: ' + ip })
    }
    next()
}

let sock = null
let latestQR = null
let authPath = 'auth_info'

// Jalankan koneksi WhatsApp
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authPath)
  const { version } = await fetchLatestBaileysVersion()

  sock = baileys.makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQR = qr
      console.log('✅ QR Code tersedia (juga bisa didapat dari /v1/login)')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('⚠️ Koneksi ditutup. Reconnect?', shouldReconnect)

      if (shouldReconnect) await startSock()
    }

    if (connection === 'open') {
      latestQR = null // reset QR saat sudah terkoneksi
      console.log('✅ Tersambung ke WhatsApp')
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    console.log('📩 Pesan masuk:', messages[0]?.message)
  })
}

await startSock()

// ========================
// API Routes
// ========================

app.get('/v1/login', checkIP, async (req, res) => {
  if (latestQR) {
    // Kirim QR Code dalam bentuk data URI
    const qrImage = await QRCode.toDataURL(latestQR)
    return res.json({ qr: qrImage })
  }

  res.json({ message: 'Sudah terhubung atau QR belum tersedia' })
})

app.post('/v1/send', checkIP, async (req, res) => {
  if (!sock) return res.status(500).json({ error: 'WhatsApp belum terhubung' })

  const { number, message } = req.body
  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`

  try {
    await sock.sendMessage(jid, { text: message })
    res.json({ status: 'Pesan dikirim', to: number })
  } catch (err) {
    console.error('❌ Gagal kirim:', err)
    res.status(500).json({ error: 'Gagal mengirim pesan' })
  }
})

app.post('/v1/logout', checkIP, async (req, res) => {
  try {
    if (sock) await sock.logout()
    fs.rmSync(authPath, { recursive: true, force: true })
    sock = null
    latestQR = null
    res.json({ message: 'Berhasil logout dan hapus session' })
  } catch (err) {
    console.error('❌ Gagal logout:', err)
    res.status(500).json({ error: 'Gagal logout' })
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`)
})
