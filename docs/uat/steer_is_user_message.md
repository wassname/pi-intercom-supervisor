# Tier 3: steer arrives as a user message

```
root: /tmp/pi-supervise-e2e-mgjpKD
extension: /media/wassname/SGIronWolf/projects5/2026/pi-supervise/src/index.ts
model: (pi default)

--- 1. supervisor pairs to the worker ---
[worker] [pi-supervise] wire in {"t":"pair","from":"019febca","forUs":true,"role":"none"}
[supervisor] [pi-supervise] wire in {"t":"pair","from":"019febca","forUs":false,"role":"supervisor"}
--- 2. worker does a turn and settles ---
[supervisor] [pi-supervise] agent_settled {"role":"supervisor","hasChannel":true}
[worker] [pi-supervise] agent_settled {"role":"worker","hasChannel":true}
[worker] [pi-supervise] published view {"bytes":176,"to":"019febca-0c35-748c-8333-8fde2444cc7a"}
[supervisor] [pi-supervise] wire in {"t":"view","from":"019febca","forUs":true,"role":"supervisor"}
worker settled, view should now be at the supervisor
--- 3. supervisor reviews and steers ---
[worker] [pi-supervise] wire in {"t":"view","from":"019febca","forUs":false,"role":"worker"}
[worker] [pi-supervise] wire in {"t":"directive","from":"019febca","forUs":true,"role":"worker"}
[supervisor] [pi-supervise] wire in {"t":"directive","from":"019febca","forUs":false,"role":"supervisor"}
[worker] [pi-supervise] agent_settled {"role":"worker","hasChannel":true}
[worker] [pi-supervise] published view {"bytes":449,"to":"019febca-0c35-748c-8333-8fde2444cc7a"}
[supervisor] [pi-supervise] wire in {"t":"view","from":"019febca","forUs":true,"role":"supervisor"}
[worker] [pi-supervise] wire in {"t":"view","from":"019febca","forUs":false,"role":"worker"}
[supervisor] [pi-supervise] agent_settled {"role":"supervisor","hasChannel":true}
worker: timed out waiting for worker turn after the steer after 240000ms
--- 4. read the worker session file ---
worker entries      : 13
worker user messages: 2

PASS: a supervisor steer is in the worker session as role user
{
 "type": "message",
 "id": "6e8fa945",
 "parentId": "b6f727d5",
 "timestamp": "2026-08-10T13:09:01.734Z",
 "message": {
  "role": "user",
  "content": [
   {
    "type": "text",
    "text": "[supervisor] Your actual goal: print the numbers 1 to 3. Do it now (e.g. run: printf '1\\n2\\n3\\n') and show the output."
   }
  ],
  "timestamp": 1786367341732
 }
}
```
