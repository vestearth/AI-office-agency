# QUICKSTART — ai-dev-office

วัตถุประสงค์
- เอกสารสั้นนี้อธิบายวิธีเรียกใช้งาน multi-agent สำหรับงานใน `ai-dev-office` ทั้งจาก CLI และใน IDE (Cursor / VS Code tasks)

Prerequisites
- ติดตั้ง Ruby และมี `gh` (GitHub CLI) ถ้าจะใช้ runner `copilot` (run-agent.sh เรียก `gh copilot`).
- เปิดสิทธิ์ให้สคริปต์: `chmod +x ai-dev-office/run-agent.sh` ถ้าจำเป็น

พื้นฐานคำสั่ง
- เรียก agent เดี่ยว ๆ (ตัวอย่างที่คุณขอ):

  ./ai-dev-office/run-agent.sh TASK-028 dev-2
  ./ai-dev-office/run-agent.sh TASK-028 reviewer

  ./ai-dev-office/run-agent.sh TASK-029 dev-2
  ./ai-dev-office/run-agent.sh TASK-031 dev-2

  ./ai-dev-office/run-agent.sh TASK-029 reviewer
  ./ai-dev-office/run-agent.sh TASK-031 reviewer

  ./ai-dev-office/run-agent.sh TASK-030 dev-2
  ./ai-dev-office/run-agent.sh TASK-030 reviewer

Runner options
- `copilot` (default): non-interactive via `gh copilot` — เหมาะเมื่อใช้ Copilot CLI
- `cursor`: จะบันทึก prompt เป็น `runs/<TASK>/.cursor-prompt.md` ให้เปิดใน Cursor/IDE แล้วรันแบบ interactive
- `codex`: ถ้าใช้ runner แบบอื่น ๆ (ตาม `run-agent.sh`)
- `copilot-chat`: ใหม่ — บันทึก prompt เป็น `runs/<TASK>/.copilot-prompt.md` เพื่อให้คุณเปิดใน VS Code แล้วส่งข้อความเป็น selected text ไปยัง GitHub Copilot Chat (interactive)

Manual Prompt Mode (IDE/CLI)
- ไฟล์ `.cursor-prompt.md` และ `.copilot-prompt.md` ช่วยให้ context/role prompt เหมือนกับการรันผ่าน `run-agent.sh`, แต่ไม่ใช่การ enforce policy โดยตัวมันเอง
- การ enforce guardrails (เช่น dependency guard, no `go.work`, no `replace` directive, Dockerfile build rules) เกิดอัตโนมัติเมื่อรันผ่าน `run-agent.sh` ใน stage ที่เกี่ยวข้อง และเกิดซ้ำอีกครั้งใน GitHub Actions
- ถ้าคุยกับ IDE/CLI ตรง ๆ โดยไม่ผ่าน `run-agent.sh`, ให้รันเช็กเองก่อน push:

- การตั้งค่าที่เกี่ยวข้อง (env): `SHARED_LIB_POLICY` (`aligned`|`latest`|`pinned`), `GUARD_SHARED_LIB_VERSION` (เมื่อ `pinned`), `EXCLUDED_SERVICES` และ `BUILD_TARGET`.
- ถ้าคุยกับ IDE/CLI ตรง ๆ โดยไม่ผ่าน `run-agent.sh`, ให้รันเช็กเองก่อน push:

  bash ai-dev-office/scripts/check-service-dependencies.sh

ตัวอย่าง: รันใน Cursor (เซฟ prompt แล้วเปิดใน Cursor)

  ./ai-dev-office/run-agent.sh TASK-028 dev-2 cursor

ตัวอย่าง: สร้าง prompt สำหรับส่งใน Copilot Chat (interactive)

  ./ai-dev-office/run-agent.sh TASK-029 dev-2 copilot-chat

  # จากนั้นเปิดไฟล์:
  # ai-dev-office/runs/TASK-029/.copilot-prompt.md
  # เลือกข้อความทั้งหมดแล้วส่งให้ Copilot Chat ใน VS Code (หรือวางในช่อง chat ของ Copilot)

บันทึกผลลัพธ์
- หลังจากรัน ให้บันทึก output ของ agent ลงไฟล์ที่ run-agent คาดหวัง (ตัวอย่าง):

  ai-dev-office/runs/TASK-028/dev-2-output.yaml

- รันตัวตรวจสอบการตั้งค่า/validation:

  ruby ai-dev-office/validate-yaml.rb TASK-028

ตัวอย่างสคริปต์รวม (แบบรวดเร็ว)
- หากต้องการสั่งทุกรายการต่อกัน สามารถรันสคริปต์เดียว (ตัวอย่าง):

  #!/usr/bin/env bash
  set -euo pipefail
  ./ai-dev-office/run-agent.sh TASK-028 dev-2
  ./ai-dev-office/run-agent.sh TASK-028 reviewer
  ./ai-dev-office/run-agent.sh TASK-029 dev-2
  ./ai-dev-office/run-agent.sh TASK-029 reviewer
  ./ai-dev-office/run-agent.sh TASK-030 dev-2
  ./ai-dev-office/run-agent.sh TASK-030 reviewer
  ./ai-dev-office/run-agent.sh TASK-031 dev-2
  ./ai-dev-office/run-agent.sh TASK-031 reviewer

VS Code `tasks.json` snippet
- ใส่ลงใน `.vscode/tasks.json` เพื่อเรียกคำสั่งจาก Command Palette หรือปุ่มลัด:

  {
    "version": "2.0.0",
    "tasks": [
      {
        "label": "ai: TASK-028 dev-2",
        "type": "shell",
        "command": "./ai-dev-office/run-agent.sh TASK-028 dev-2",
        "group": "build",
        "presentation": { "reveal": "always" }
      },
      {
        "label": "ai: TASK-028 reviewer",
        "type": "shell",
        "command": "./ai-dev-office/run-agent.sh TASK-028 reviewer",
        "presentation": { "reveal": "always" }
      }
    ]
  }

คำแนะนำสั้นๆ
- ถ้าใช้ `cursor` runner: เปิดไฟล์ `ai-dev-office/runs/<TASK>/.cursor-prompt.md` ใน Cursor แล้วส่งผลลัพธ์กลับเป็น `-output.yaml` และรัน `validate-yaml.rb`.
- ตรวจสอบว่า `ai-dev-office/run-agent.sh` อยู่ใน repository และมีสิทธิ์รัน: [ai-dev-office/run-agent.sh](ai-dev-office/run-agent.sh)
- ไฟล์ task และผลลัพธ์จะอยู่ที่: [ai-dev-office/runs/](ai-dev-office/runs/)
- ใช้ `ruby ai-dev-office/validate-yaml.rb <TASK-ID>` เพื่อยืนยันรูปแบบ runtime

ต้องการให้ผมเพิ่ม
- สร้างไฟล์ `.vscode/tasks.json` อัตโนมัติหรือ
- สร้างสคริปต์ `ai-dev-office/quickrun.sh` ที่รันชุดคำสั่งตามที่ระบุ?

ไฟล์นี้ถูกสร้างเพื่อช่วยเริ่มต้นอย่างรวดเร็ว — บอกผมว่าต้องการให้ผมสร้างไฟล์ tasks หรือสคริปต์จริงไหม

ตัวอย่างสำหรับ TASKs ในอนาคต (templates)
--
1) `runs/<TASK-ID>/task.md` — ตัวอย่างโครงสร้างเบื้องต้น

```yaml
task:
  id: TASK-028
  title: Short task title
  short_name: short-name
  epic: optional-epic
  description: |
    คำอธิบายสั้น ๆ ของงานและเงื่อนไขที่ต้องการ
  priority: medium
  owner: team-or-person
```

2) Output filename convention
- Agent outputs ต้องถูกบันทึกเป็น: `runs/<TASK-ID>/<agent>-output.yaml` (ตัวอย่าง: `runs/TASK-028/dev-2-output.yaml`).

3) Quick run patterns
- ใช้ `run-agent.sh` หรือสคริปต์เล็ก ๆ เพื่อรันลำดับ agent สำหรับ TASKs ใหม่ ๆ (ไม่ต้องพึ่งไฟล์เสริม)

Run default agents (`dev-2` then `reviewer`) for TASK-028:

  ./ai-dev-office/run-agent.sh TASK-028 dev-2
  ./ai-dev-office/run-agent.sh TASK-028 reviewer

Run specific agents for TASKs (ตัวอย่าง):

  ./ai-dev-office/run-agent.sh TASK-029 dev-2
  ./ai-dev-office/run-agent.sh TASK-029 reviewer
  ./ai-dev-office/run-agent.sh TASK-031 dev-2

4) VS Code tasks template for many TASKs
- Add this snippet to `.vscode/tasks.json` and duplicate per TASK or generate programmatically. Example runs `dev-2` then `reviewer`.

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "ai: quickrun TASK-028",
      "type": "shell",
      "command": "./ai-dev-office/run-agent.sh TASK-028 dev-2 && ./ai-dev-office/run-agent.sh TASK-028 reviewer",
      "presentation": { "reveal": "always" }
    },
    {
      "label": "ai: quickrun TASK-029",
      "type": "shell",
      "command": "./ai-dev-office/run-agent.sh TASK-029 dev-2 && ./ai-dev-office/run-agent.sh TASK-029 reviewer",
      "presentation": { "reveal": "always" }
    }
  ]
}
```

5) Validation and iteration
- หลังรัน agent แต่ละครั้ง ให้รัน:

  ruby ai-dev-office/validate-yaml.rb <TASK-ID>

6) Conventions / recommendations
- ตั้งชื่อ `short_name` ให้สั้นและเป็น slug เพื่อให้แสดงใน `TASK_LABEL` (run-agent ใช้ `short_name` อัตโนมัติ)
- บันทึก `pm-output.yaml` ถ้ามีข้อมูลการตั้งค่าเริ่มต้นของงาน
- ถ้ารันแบบ interactive ใช้ runner `cursor` เพื่อแก้ไข prompt ใน Cursor แล้วบันทึก `-output.yaml`

**Roles & Examples**

สรุปบทบาทของแต่ละ agent และตัวอย่างคำสั่ง `run-agent.sh` เพื่อเรียกใช้:

- `pm`: ระบุงาน สร้าง `pm-output.yaml` และมอบหมายงานให้ devs / กำหนดสเปคเริ่มต้น.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 pm`

- `dev`: ผู้พัฒนาหลัก — ลงมือเขียนโค้ดหรือแก้ไขตามสเปค และส่ง `dev-output.yaml` เป็นผลลัพธ์.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 dev`

- `dev-2`: ผู้พัฒนารอง / งานข้ามขอบเขต — เหมาะกับงานที่ต้องคนที่สองหรือการเปลี่ยนแปลงขนาดใหญ่.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 dev-2`

- `reviewer`: ตรวจสอบผลงานจาก `dev`/`dev-2` — ให้ `review_verdict` และ `next_action` (approved/changes_requested/etc.).
  - Example: `./ai-dev-office/run-agent.sh TASK-028 reviewer`

- `debugger`: ช่วยไล่หาบั๊กและระบุสาเหตุหลัก, ให้คำแนะนำเชิงเทคนิคหรือ reproduction steps.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 debugger`

- `devops`: จัดการปัญหาอินฟรา, CI/CD, deployment, และข้อผิดพลาดที่ต้องการสิทธิ์โครงสร้างพื้นฐาน.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 devops`

- `tester`: รันชุดทดสอบหรือออกแบบกรณีทดสอบ — ผลลัพธ์เป็นไฟล์ทดสอบหรือรายงาน (เช่น `tester-output.yaml`).
  - Example: `./ai-dev-office/run-agent.sh TASK-028 tester`

- `planner`: สร้างแผนงาน (tasks/subtasks, milestones) และรายละเอียดการทำงานสำหรับ `pm`/`dev`.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 planner`

- `free-roam`: การสำรวจ/escalation — รันเพื่อหาทางออกเมื่องานติดหรือมีความไม่ชัดเจนสูง.
  - Example: `./ai-dev-office/run-agent.sh TASK-028 free-roam`

หมายเหตุ:
- ชื่อไฟล์ output ต้องเป็น `runs/<TASK-ID>/<agent>-output.yaml` เพื่อให้ `run-agent.sh` และ `validate-yaml.rb` ทำงานร่วมกันได้
- โฟลว์ตัวอย่างทั่วไป: `pm` → `dev`/`dev-2` → `reviewer` → (`debugger` | `devops` | `free-roam`) → `reviewer` → `done`

ต้องการให้ผมสร้างไฟล์ `ai-dev-office/quickrun.sh` ใน repo เลยไหมครับ? ถ้าใช่ ผมจะเพิ่มสคริปต์และตั้งไว้ executable instruction ด้วย

