# Multi-user — หลายคน หลายเครื่อง sync ผ่าน git

โหมดนี้ทุกคน clone repo เดียวกัน ทำงานบนเครื่องตัวเอง แล้ว sync สถานะ run ผ่าน
git remote (`runs/` ถูก commit แบบ allowlist — ดู `.gitignore`)
จุดที่ชนกันได้มี 3 จุด และแก้ตามนี้:

| จุดชน | ทางแก้ |
|---|---|
| จองเลข TASK พร้อมกัน | namespace เลขต่อคน (`task_prefix`) — เลขไม่มีทางซ้ำข้ามเครื่อง |
| prefix ซ้ำกันเงียบ ๆ | registry กลาง `office.team.yaml` (committed) — intake บังคับให้ลงทะเบียนก่อน |
| แก้ `status.yaml` task เดียวกันสองเครื่อง | กติกา one task = one assignee |
| เขียน `decision.yaml` ซ้อนกัน | reviewer คนเดียวต่อ task + dashboard เครื่องตัวเอง |
| ลืม pull/push | `git_sync.enabled: true` — run-agent.sh pull/push ให้อัตโนมัติ |

## 1. ตั้ง task prefix (ครั้งเดียวต่อคน)

**ทางลัด:** กรอกชื่อในช่อง "Your name (used on decisions)" บน dashboard —
ระบบจะย่อชื่อเป็น prefix (เช่น "Earth Sripian" → `ES`) เลี่ยง prefix ที่คนอื่น
จองแล้วใน registry อัตโนมัติ (ES ไม่ว่าง → EAR → ES2 …) แล้วเขียนให้ทั้ง
`office.config.local.yaml` (ของเครื่องคุณ) และ `office.team.yaml` (registry
กลาง — ต้อง commit+push เพื่อประกาศ claim) พร้อมแสดง badge `TASK-ES-…`
ข้างช่องชื่อ ถ้า prefix ที่ตั้งไว้ถูกคนอื่นจองอยู่ badge จะเป็นสีแดง ⚠
การ derive เกิดเฉพาะตอนยังไม่มี prefix — ค่าที่ตั้งไว้แล้วไม่มีวันถูกทับ
(ชื่อภาษาไทยล้วน derive ไม่ได้ ต้องตั้งเองตามด้านล่าง)

หรือตั้งเองโดยสร้าง `office.config.local.yaml` ที่ root ของ ai-dev-office
(ไฟล์นี้ gitignored):

```yaml
office:
  task_prefix: EA   # ตัวพิมพ์ใหญ่ ขึ้นต้นด้วยตัวอักษร — ห้ามซ้ำกันในทีม
```

หรือใช้ env แทน: `export OFFICE_TASK_PREFIX=EA`
(env ชนะ config; `PKG` สงวนไว้สำหรับ package tasks)

จากนั้น `./run-agent.sh intake "..."` จะจองเลขใน namespace ของตัวเอง:

- Earth → `TASK-EA-001`, `TASK-EA-002`, …
- Bob → `TASK-BOB-001`, …

เลขเดิมแบบ `TASK-NNN` ยังใช้ได้ (legacy pool) แต่**ห้ามใช้พร้อมกันหลายเครื่อง**
เพราะการนับ max+1 จะ race กัน — ทุกคนในทีมต้องมี prefix

Validator, `run-agent.sh status`, dashboard และ schemas รองรับ id ทั้งสามแบบ:
`TASK-NNN`, `TASK-PKG-NNN`, `TASK-<PREFIX>-NNN`

### Registry กลาง: `office.team.yaml` (committed)

ไฟล์เดียวที่ทั้งทีมเห็นว่า prefix ไหนเป็นของใคร — claim โดยเพิ่มบรรทัด
`<PREFIX>: <ชื่อ>` ใต้ `prefixes:` แล้ว commit+push: dashboard **เพิ่มบรรทัด**
ให้อัตโนมัติ แต่ส่วน commit+push เกิดตอน run-agent.sh push ครั้งถัดไป
เมื่อเปิด `git_sync` (ถ้าไม่เปิดต้อง `git add office.team.yaml && git commit &&
git push` เองเพื่อประกาศ claim — ไม่งั้นทีมยังไม่เห็น)
สองคน claim prefix เดียวกัน = git conflict บรรทัดเดียวที่มองเห็น แทนที่จะ
ชนกันเงียบ ๆ ใน task id

**Enforcement:** ทันทีที่ registry มีอย่างน้อย 1 รายการ `intake` จะ:
- ปฏิเสธ intake ที่ไม่มี prefix (กัน TASK-NNN pool กลางที่ race ข้ามเครื่อง)
- ปฏิเสธ prefix ที่ยังไม่ลงทะเบียน (พร้อมบอกบรรทัดที่ต้องเพิ่ม)
- แสดงเจ้าของ prefix ใน preview (`Prefix owner: Earth`)

ตราบใดที่ registry ว่าง พฤติกรรมเดิม (โหมดคนเดียว) ไม่เปลี่ยน

## 2. กติกา ownership

- **One task = one assignee.** เครื่องของ assignee (ตาม `assignment.primary`)
  เท่านั้นที่แก้ `status.yaml` และ `*-output.yaml` ของ task นั้น
  เครื่องอื่นอ่านอย่างเดียว — งานคนละ task อยู่คนละ directory จึงไม่ conflict
- **Reviewer คนเดียวต่อ task.** decision เขียนผ่าน dashboard บนเครื่องของ
  reviewer (append เข้า `decision.yaml`) แล้ว push; ฝั่ง assignee pull มา
  reconcile (`scripts/reconcile-decision.rb`) — คนละไฟล์กับ status.yaml
  จึง merge ผ่าน git ได้สะอาด
- `meta.yaml` และ `*.log` เป็น local-only (gitignored) — ไม่มีทาง conflict

## 3. Sync — เปิด auto ได้แล้ว (แนะนำ)

```yaml
# office.config.local.yaml (หรือใน office.config.yaml ให้ทั้งทีม)
git_sync:
  enabled: true
```

เมื่อเปิด `run-agent.sh` จะจัดการ ritual ทั้งหมดให้:

- **ก่อน intake / dispatch:** `git pull --rebase --autostash` (auto pipeline
  pull ครั้งเดียวต่อ pipeline ไม่ใช่ทุก step)
- **หลังจบทุก step** (รวม validation_failed, loop guard, human decision):
  commit `runs/<TASK-ID>/` + `office.team.yaml` แล้ว push — push โดน reject
  ก็ rebase แล้ว retry ให้เอง
- commit จำกัด pathspec ของ task นั้น — ไม่กวาดไฟล์อื่นที่ค้างอยู่ติดไปด้วย
- **Offline ไม่ block งาน:** pull/push ล้มเหลวแค่เตือน state ถูก commit
  local ไว้ push ตามทีหลัง; rebase ติด conflict จะ abort ให้เอง ไม่ทิ้งค้าง

ปิดชั่วคราวด้วย `OFFICE_GIT_SYNC=0` (หรือเปิดเฉพาะครั้งด้วย `=1`)

ถ้าไม่เปิด auto ritual เดิมยังใช้ได้:

```bash
# ก่อน intake หรือ dispatch agent ทุกครั้ง
git -C ai-dev-office pull --rebase

# หลังจบ agent step (status.yaml / *-output.yaml เปลี่ยน)
git -C ai-dev-office add runs/<TASK-ID> && git -C ai-dev-office commit -m "<TASK-ID>: <step>" && git -C ai-dev-office push
```

push ทันทีหลังสร้าง run ใหม่ = ประกาศ claim ให้ทีมเห็นเร็วที่สุด

## 4. ถ้า conflict เกิดจนได้

`status.yaml` conflict แปลว่ามีคนละเมิดกติกา one-assignee — ให้ยึดเวอร์ชันของ
assignee (`git checkout --theirs/--ours` ตามทิศ rebase) แล้วรัน
`ruby validate-yaml.rb <TASK-ID>` + reconcile decision ใหม่
ห้าม merge YAML ด้วยมือแบบเดา ๆ — history array เสียง่าย

## 5. Dashboard ในโหมดนี้

แต่ละคนรัน dashboard ของตัวเอง (`npm run dev`) ชี้ clone ของตัวเอง —
dashboard เป็น read-only ยกเว้นปุ่ม decision ซึ่ง serialize ภายใน process
เดียวอยู่แล้ว ข้อควรระวังเดียวคืออย่าเปิด dashboard สองเครื่องไปกด decision
task เดียวกันพร้อมกัน (กติกา reviewer คนเดียวต่อ task ครอบอยู่แล้ว)
