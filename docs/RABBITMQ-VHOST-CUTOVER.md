# RabbitMQ prod broker — รายการที่ต้องตั้ง แยกตาม repo

สำหรับ devops · 2026-09-15 · TASK-EAR-309

---

## ✅ อัปเดต 2026-09-15 — devops ตั้ง broker ตัวใหม่แยกให้เลย

**ไม่ใช้ vhost แล้ว** devops ตั้ง RabbitMQ **instance ใหม่แยกสำหรับ prod** ซึ่งเป็น
**option B** ในตารางเทียบทางเลือก และ**แข็งแรงกว่า vhost**

### สิ่งที่ดีขึ้นจากแผน vhost

| | vhost | **broker แยก** |
|---|---|---|
| กันข้อมูลปนกัน | ✅ | ✅ |
| **แยก failure domain** | ❌ *(staging ถล่มยังกระทบ prod)* | ✅ **แยกจริง** |
| แยกทรัพยากร (disk/RAM/fd) | ❌ | ✅ |
| ต่อผิดที่แล้วเงียบ | ⚠️ vhost ผิด = queue ว่าง ไม่มี error | ✅ host ผิด = **ต่อไม่ติด error ทันที** |

**ข้อเสียหลักสองข้อของ vhost หายไปทั้งคู่** — ทั้งเรื่อง failure domain ที่ผมเขียนไว้ตรงๆ ว่า
vhost ไม่ได้แก้ และเรื่อง "ต่อผิด vhost แล้วเงียบ" ซึ่งเป็น failure mode ใหม่ที่ vhost สร้างขึ้น
broker คนละตัวไม่มีทั้งสองปัญหา

### ยังต้องถามกลับ 3 ข้อ

1. **host:port ของ broker ใหม่** — และอยู่ที่ไหน
2. **อยู่ใน prod VPC (`10.90.0.0/16`) หรือเป็น public IP อีกตัว** ถ้าอยู่ใน VPC ได้จะดีมาก
   เพราะจะปิดเรื่อง "credential วิ่งข้ามอินเทอร์เน็ตแบบไม่เข้ารหัส" ไปพร้อมกันเลย
   แบบเดียวกับที่ ClickHouse prod เพิ่งย้ายไปอยู่ `10.90.131.165` (TASK-EAR-308)
3. **TLS (5671) หรือ plaintext (5672)** — ถ้าเป็น broker ใหม่อยู่แล้ว เปิด TLS ตั้งแต่ต้นถูกกว่ามาแก้ทีหลัง

## ค่าที่จะใส่

**ชื่อ:** `RABBITMQ_URL`
**ที่:** GitHub → repo → Settings → Environments → **`production`** → Secrets
**รูปแบบ:**

```
amqp://<user>:<password>@<host ใหม่>:<port>/
```

vhost ใช้ `/` ปกติได้เลย — ไม่ต้องมี `/prod` ต่อท้ายอีกแล้ว เพราะแยกด้วย host

## 8 repo — แยกเป็นสองกลุ่ม

### กลุ่ม A · **เพิ่มใหม่** (6 repo)

ยังไม่มี secret ระดับ environment `production` เลย ตอนนี้ใช้ค่าจาก **repo-level** ร่วมกับ
staging การเพิ่ม secret ที่ระดับ `production` จะ**override เฉพาะ prod** — **staging ไม่ถูกแตะ**

| repo |
|---|
| `Games-Labs-Wallet` |
| `Games-Labs-Game` |
| `Games-Labs-Auth` |
| `Games-Labs-User` |
| `Games-Labs-Logs` |
| `Games-Labs-Provider` |

### กลุ่ม B · **แก้ค่าเดิม** (2 repo) ⚠️

มี secret ที่ระดับ `production` อยู่แล้ว ต้อง **update ไม่ใช่ add**

| repo | ค่าปัจจุบัน | หมายเหตุ |
|---|---|---|
| `Games-Labs-Order` | Contabo vhost `/` | ตัวเดียวที่ไม่มี repo-level fallback — staging ก็เป็น environment secret แยกอยู่แล้ว **อย่าไปแตะของ staging** |
| `Games-Labs-Missions` | **Amazon MQ ที่ไม่มีอยู่จริง** | `b-e177fb2b-….mq.ap-southeast-1.on.aws:5671` — DNS ไม่ resolve ไม่มี ENI ในทั้งสอง VPC ต้องเขียนทับด้วย Contabo `/prod` |

### ไม่เกี่ยว

`api-gateway` ไม่ได้ใช้ RabbitMQ — ข้ามได้

---

## ❌ สิ่งที่ **ไม่ต้อง** เปลี่ยน

- **ชื่อ queue ทั้งหมด** — `RABBITMQ_QUEUE_*` และ `RABBITMQ_CONSUMER_TAG_*` คงเดิมทุกตัว
  vhost scope ชื่อ queue ให้อยู่แล้ว ชื่อซ้ำข้าม vhost ไม่ชนกัน **การเปลี่ยนชื่อ queue จะทำให้แย่ลง**
- **staging** — ทุกอย่างคงเดิม
- **โค้ด** — ไม่ต้องแก้ ไม่ต้อง deploy ใหม่เพื่อสร้าง queue

## ✅ สิ่งที่โค้ดทำให้เอง

ทุก consumer เรียก `QueueDeclare` + `QueueBind` ตอน boot และ publisher ใช้ `amq.topic`
ซึ่งเป็น built-in exchange ที่มีอยู่ในทุก vhost → **queue, binding และ exchange จะถูกสร้างเอง
บน broker ใหม่ตอน service ตัวแรก start** ไม่ต้องสร้างมือ

---

## แผนทดสอบครั้งเดียวหลังตั้งครบ

ทำตามลำดับนี้ ใช้เวลาไม่นาน

### 1 · ตรวจค่าที่ render ออกมา (ยังไม่ต้อง start อะไร)

หลัง devops ใส่ครบแล้ว ให้ deploy prod ของทั้ง 8 repo (register task definition เฉยๆ —
prod อยู่ที่ `desiredCount: 0` จึงไม่มี task ขึ้น) แล้วผมเช็คให้ว่า **ทั้ง 8 ตัวได้ fingerprint
เดียวกัน และต่างจาก staging** พร้อมยืนยันว่า **vhost path ต่างจริง ไม่ใช่แค่รหัสผ่านเปลี่ยน**

### 2 · ทดสอบการเชื่อมต่อจริง

scale service ขึ้น **ทีละตัว** (เริ่มที่ Logs หรือ Auth ซึ่งไม่ใช่ money path) แล้วดู log
ว่าต่อ RabbitMQ ติดและ declare queue สำเร็จ

✅ **ข้อดีของ broker แยก:** ถ้าตั้ง host ผิด service จะ **ต่อไม่ติดและ error ทันที** ไม่เงียบ
เหมือนกรณี vhost ผิด — แต่ก็ยังควรยืนยันว่า **queue ถูกสร้างขึ้นบน broker ใหม่**
ในหน้า management จริง

### 3 · ทดสอบ end-to-end หนึ่งเส้น

ทางที่พิสูจน์ได้ครบที่สุดคือ `player.activity` เพราะมันผ่าน exchange:
ยิง activity หนึ่งครั้งบน prod → ดูว่า **Missions บน prod รับได้** และ
**Missions บน staging ไม่ได้รับ** ← ข้อหลังคือข้อที่พิสูจน์ว่าการแยกได้ผลจริง

---

## ถ้าอยากย้อนกลับ

เปลี่ยน `RABBITMQ_URL` กลับเป็นค่าเดิมแล้ว redeploy — ไม่มี migration ไม่มี state ค้าง
message ที่อยู่บน broker ใหม่จะค้างอยู่ตรงนั้นเฉยๆ ไม่หาย
