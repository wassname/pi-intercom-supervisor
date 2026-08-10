# Tier 3: steer arrives as a user message

```
root: /tmp/pi-supervise-e2e-OOpfDf
extension: /media/wassname/SGIronWolf/projects5/2026/pi-supervise/src/index.ts
model: (pi default)

--- 1. supervisor pairs to the worker ---
[worker] [pi-supervise] wire in {"t":"pair","from":"019febdb","forUs":true,"role":"none"}
[supervisor] [pi-supervise] wire in {"t":"pair","from":"019febdb","forUs":false,"role":"supervisor"}
--- 2. worker does a turn and settles ---
[supervisor] [pi-supervise] agent_settled {"role":"supervisor","hasChannel":true}
[worker] [pi-supervise] agent_settled {"role":"worker","hasChannel":true}
[worker] [pi-supervise] published view {"bytes":176,"to":"019febdb-482a-777c-ad61-ee19d21caf4b"}
[supervisor] [pi-supervise] wire in {"t":"view","from":"019febdb","forUs":true,"role":"supervisor"}
worker settled, view should now be at the supervisor
--- 3. supervisor reviews and steers ---
[worker] [pi-supervise] wire in {"t":"view","from":"019febdb","forUs":false,"role":"worker"}
[worker] [pi-supervise] wire in {"t":"directive","from":"019febdb","forUs":true,"role":"worker"}
[supervisor] [pi-supervise] wire in {"t":"directive","from":"019febdb","forUs":false,"role":"supervisor"}
[worker] [pi-supervise] agent_settled {"role":"worker","hasChannel":true}
[worker] [pi-supervise] published view {"bytes":366,"to":"019febdb-482a-777c-ad61-ee19d21caf4b"}
[supervisor] [pi-supervise] wire in {"t":"view","from":"019febdb","forUs":true,"role":"supervisor"}
[worker] [pi-supervise] wire in {"t":"view","from":"019febdb","forUs":false,"role":"worker"}
[supervisor] [pi-supervise] agent_settled {"role":"supervisor","hasChannel":true}
(worker had already settled)
--- 4. read the worker session file ---
worker entries      : 9
worker user messages: 2

PASS: a supervisor steer is in the worker session as role user
{
 "type": "message",
 "id": "091cacc6",
 "parentId": "e23aaae6",
 "timestamp": "2026-08-10T13:28:00.805Z",
 "message": {
  "role": "user",
  "content": [
   {
    "type": "text",
    "text": "[supervisor] Ignore the previous request. Your actual goal: print the numbers 1 to 3. Do it now (e.g. run a command or just output them), and show the output."
   }
  ],
  "timestamp": 1786368480803
 }
}
```
