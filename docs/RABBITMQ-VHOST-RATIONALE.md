# ทำไมต้องแยก vhost — ข้อดี ข้อเสีย และสิ่งที่มันไม่ได้แก้

สำหรับ devops · 2026-09-15 · อ้างอิง TASK-EAR-309

**คำถาม:** อยู่บน Contabo ตัวเดียวกันอยู่แล้ว การแยก vhost ดีกว่ารวมแบบปัจจุบันยังไง

**คำตอบสั้น:** vhost ไม่ได้ทำให้ทนทานขึ้น ไม่ได้เพิ่มทรัพยากร และไม่ได้แยก failure domain —
มันแก้เรื่องเดียวคือ **ความถูกต้องของข้อมูล** ซึ่งตอนนี้ผิดอยู่จริงและวัดได้

---

## 1 · ปัญหาที่เกิดขึ้นจริงถ้าไม่แยก

ตอนนี้ทุก service ทั้ง prod และ staging ใช้ **connection string เดียวกันทุกไบต์** — host, user
`admin`, password, vhost `/` เหมือนกันหมด (ตรวจจาก ECS task definition ที่ render แล้ว 7 ตัว)

ปัญหาไม่ได้อยู่ที่ credential แต่อยู่ที่ **ชื่อ queue ซ้ำกันบน namespace เดียวกัน**

### กระทบ 6 stream ไม่ใช่แค่ Missions

| stream | ใครส่ง → ใครรับ |
|---|---|
| `player.activity.v1` *(ผ่าน exchange)* | Game · Order · Wallet → Missions, Logs |
| `user.registered` | Auth → User |
| `user.registered.wallet` | Auth → Wallet |
| `admin.actions` | 6 service → Logs |
| `events.provider.logs` | Provider → Logs |
| `account.status.notifications` | Auth |

### กลไกที่ทำให้พัง มีสองแบบ และแย่คนละอย่าง

**แบบที่ 1 — ชื่อ queue เหมือนกัน (สภาพปัจจุบัน)**
RabbitMQ ทำ round-robin ระหว่าง consumer ทุกตัวบน queue เดียวกัน พอเปิด prod ขึ้นมา
consumer ของ prod กับ staging จะอยู่บน queue เดียวกัน → **event ของผู้เล่นจริงจะถูกส่งไปให้
staging ประมาณครึ่งหนึ่ง แล้วหายไปเลย** ผู้เล่นจริงจะเห็น mission ไม่ขยับแบบสุ่ม
ประมาณ 50% และไม่มี error ที่ไหนเลย

**แบบที่ 2 — เปลี่ยนชื่อ queue ให้ต่างกัน (ทางที่ดูเหมือนจะง่ายกว่า)**
`player.activity` ไม่ได้ยิงเข้า queue ตรงๆ แต่ publish เข้า **exchange `amq.topic`**
แล้ว consumer ค่อย bind queue ของตัวเองเข้าไป — ถ้า queue คนละชื่อ bind exchange เดียวกัน
ด้วย routing key เดียวกัน **แต่ละ queue จะได้สำเนาของตัวเอง** แปลว่า staging จะประมวลผล
event ของ production **ทุกตัว** และ production จะประมวลผล event ของ QA **ทุกตัว**

**แบบที่ 2 แย่กว่าแบบที่ 1** — ตอนนี้แค่หายไปครึ่งหนึ่ง แต่แบบที่ 2 คือ
**mission ของผู้เล่นจริงขยับตามการเทสของ QA และ wallet/turnover ปนกันสองทาง**

### ทำไมแก้ด้วย config ไม่ได้

| ส่วนประกอบ | ค่า | แก้ผ่าน env ได้ไหม |
|---|---|---|
| exchange | `amq.topic` — `Games-Labs-Missions/infrastructures/rabbitmq.go:18` | ❌ **hardcode เป็น Go constant** |
| routing key | `player.activity.v1` — `shared-lib/events/player_activity.go:7` | ❌ constant ใน shared-lib |
| ชื่อ queue | `player.activity.missions` | ✅ |

จะแยกด้วย exchange ต้องแก้โค้ดทุก publisher ทุก consumer และ shared-lib — ไม่ใช่งาน config
แล้ว และเป็นความเสี่ยงที่ไม่ควรรับก่อน launch ไม่กี่วัน

---

## 2 · ข้อดีของการแยก vhost

- **แก้ปัญหาข้อ 1 ได้ทั้งหมด** vhost scope ทั้ง exchange และ queue — แต่ละ vhost มีชุด
  built-in exchange ของตัวเอง รวมถึง `amq.topic` ด้วย
- **ไม่ต้องแก้โค้ดเลย และไม่ต้องเปลี่ยนชื่อ queue** เปลี่ยนแค่ connection string ของ
  7 service
- **โค้ดสร้าง queue/binding ให้เองตอน start** ทุก consumer เรียก `QueueDeclare` +
  `QueueBind` ตอน boot และ publisher ใช้ `amq.topic` ซึ่งมีอยู่ในทุก vhost อยู่แล้ว →
  **ไม่ต้องสร้าง queue มือ** ย้ายแล้วติดเลย
- **ไม่เพิ่มทรัพยากร ไม่เพิ่มค่าใช้จ่าย** ไม่มี process ใหม่ ไม่มี port ใหม่ ไม่มี RAM/disk
  เพิ่ม — vhost คือ namespace ในกระบวนการเดิม
- **แยกสิทธิ์ได้** ตั้ง permission ให้ user ของ staging เข้าถึงเฉพาะ `/` และ user ของ prod
  เฉพาะ `/prod` → QA เผลอชี้ผิดจะ **ต่อไม่ติดและ error ทันที** แทนที่จะต่อติดแล้วกินข้อมูลผิด
- **ย้อนกลับได้ในคำสั่งเดียว** ถ้ามีปัญหา เปลี่ยน connection string กลับแล้ว redeploy
- **ทำตอนนี้แทบไม่มีต้นทุน** prod ยังอยู่ที่ `desiredCount: 0` ไม่มี consumer รัน ไม่มี
  message ค้าง **ไม่ต้อง drain ไม่ต้องมีช่วง dual-consume** หลัง launch งานเดียวกันนี้ต้องมีทั้งสองอย่าง

---

## 3 · ข้อเสียและข้อจำกัด — ที่ควรรู้ก่อนตัดสิน

ข้อพวกนี้จริงทั้งหมด และ vhost ไม่ได้แก้ให้

- 🔸 **ไม่ได้แยก failure domain** ยังเป็น broker ตัวเดียว disk ก้อนเดียว RAM ก้อนเดียว
  file descriptor pool เดียวกัน — **staging ยิงถล่มหรือ consumer ค้างจนคิวบวม ยังทำ prod
  ช้าหรือล่มได้เหมือนเดิม** vhost คือ namespace ไม่ใช่ bulkhead ถ้าต้องการแยกจุดพังจริง
  ต้องเป็น broker คนละตัว
- 🔸 **ไม่ได้แยกทรัพยากร** memory watermark, disk free limit, connection limit ใช้ร่วมกันหมด
- 🔸 **เพิ่ม failure mode ใหม่หนึ่งแบบ** ถ้าตั้ง connection string ผิด vhost จะ
  **ต่อติดปกติแต่ queue ว่างเปล่า ไม่มี error** — เป็นความเงียบแบบเดียวกับที่เราเพิ่งเจอมา
  *(ลดได้ด้วยการตั้ง permission แยกตามข้อ 2 — ผิด vhost แล้วจะ ACCESS_REFUSED ทันที)*
- 🔸 **policy เป็นราย vhost** ถ้ามี HA policy, TTL, DLX, หรือ federation ตั้งไว้บน `/`
  ต้องสร้างใหม่บน `/prod` ด้วย ไม่ได้ย้ายตามอัตโนมัติ
- 🔸 **monitoring/dashboard ต้องเพิ่มมุมมองราย vhost** ไม่งั้นตัวเลขจะรวมกันเหมือนเดิม
- 🔸 **งาน ops เพิ่มเล็กน้อยถาวร** user/permission/policy เพิ่มอีกชุดที่ต้องดูแล
- 🔸 **ไม่ได้แก้เรื่อง plaintext** ยังเป็น `84.247.150.206:5672` ซึ่งเป็น public IP บน port
  ที่ไม่เข้ารหัส — เป็นคนละเรื่อง แก้ด้วย TLS (5671) หรือ VPN/peering แยกต่างหาก
- 🔸 **credential ยังอยู่ใน task definition แบบ plain** ใครมีสิทธิ์
  `ecs:DescribeTaskDefinition` อ่านได้ — ควรย้ายเข้า Secrets Manager เหมือน `POSTGRES_*`

---

## 4 · เทียบทางเลือกทั้งหมด

| ทางเลือก | แก้ข้อมูลปนกัน | แยก failure domain | ต้องแก้โค้ด | ต้นทุน |
|---|---|---|---|---|
| **คงสภาพเดิม** | ❌ event หายสุ่ม ~50% | ❌ | — | 0 |
| **เปลี่ยนชื่อ queue** | ❌ **แย่กว่าเดิม** — ได้สำเนาคนละชุด | ❌ | ไม่ต้อง | 0 |
| **แยก vhost** ← เสนอ | ✅ | ❌ | **ไม่ต้อง** | ~0 |
| **แยก exchange** | ✅ | ❌ | **ต้อง** — ทุก service + shared-lib | สูง |
| **แยก broker** | ✅ | ✅ | ไม่ต้อง | มีค่าใช้จ่าย + งาน ops |

---

## 5 · สรุปให้ตัดสิน

**vhost คือทางที่แก้ปัญหาถูกต้องด้วยต้นทุนต่ำสุด แต่ไม่ได้ทำให้ระบบทนทานขึ้น**

ถ้ารับความเสี่ยงเรื่อง failure domain ร่วมกันได้ (ซึ่งตอนนี้ก็รับอยู่แล้ว) vhost เพิ่มความถูกต้อง
โดยแทบไม่แลกอะไรเลย

ถ้าอยากได้ทั้งความถูกต้องและความทนทาน ต้องเป็น broker แยก ซึ่งมีค่าใช้จ่ายและงาน ops
จริง — เป็นการตัดสินใจคนละระดับ และเลื่อนไปทำหลัง launch ได้ **แต่การแยก namespace
เลื่อนไม่ได้ เพราะพอเปิด prod แล้วข้อมูลจะเริ่มปนทันที**

**คำสั่งที่ขอ:**

```bash
rabbitmqctl add_vhost /prod
rabbitmqctl add_user gameslabs_prod '<password>'
rabbitmqctl set_permissions -p /prod gameslabs_prod '.*' '.*' '.*'
# แนะนำเพิ่ม: จำกัด user เดิมให้เข้าได้เฉพาะ / เพื่อให้ชี้ผิดแล้ว error ทันที
```

จากนั้นฝั่งเราเปลี่ยน `RABBITMQ_URL` ของ 7 service ให้ชี้ `/prod` — เป็นงาน config
ไม่แตะโค้ด และทำได้ทันทีตราบที่ prod ยังไม่ scale ขึ้น
