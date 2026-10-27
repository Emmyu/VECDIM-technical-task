# VECDIM demo: narration script

This is exactly what the narrator says in `VECDIM_demo_voiced.mp4` (a Nigerian English voice, en-NG-AbeoNeural).
`VECDIM_demo_captions_only.mp4` is the same walkthrough with captions only and no voice.

If you would rather use your own voice, read these lines while the captioned video plays. Each block starts at the time shown and is timed to fit the scenes on screen.
Read it in your own words if you like: the points matter more than the exact sentences.

---

**0:00**
"Hello, this is my Vecdim submission. It's a field app for the phone, a backend, the R analysis, and a dashboard. Let me follow one record from the phone, all the way to an alert."

**0:10**
"First, I've put the phone in airplane mode, so there's no network at all. The app still works, because everything is saved on the phone itself."

**0:19**
"Now the GPS. At 18 metres it only warns me, since the target is 10. At 60 metres it won't let me save, because that's not usable. And 6 metres is fine."

**0:30**
"If the point is far from the LGA I picked, it warns me to check, in case I chose the wrong one."

**0:36**
"As I type the counts, it works out the mortality and the WHO class straight away. 54 percent, so that's resistant."

**0:43**
"If I enter more dead than exposed, it stops me and shows the error. So I fix the number, and save."

**0:50**
"Saved records wait in a queue. The app keeps retrying on its own, starting at 5 seconds and waiting longer each time, up to 15 minutes."

**0:59**
"Now I start another record, and kill the app halfway, like the battery died. When I open it again, it offers to continue, with the same record, the same GPS and the same numbers. Nothing is lost."

**1:11**
"When the network comes back, the queue uploads. Every record has its own ID from the phone, so if it's sent twice, or the connection drops halfway, the server still keeps only one."

**1:22**
"That upload makes the backend run the programme's own R code, and nobody types a command. It cleans the data, flags the bad rows, trains the risk model, and builds the alerts. The new phone records are counted, but they still wait for climate data."

**1:36**
"The server can also say no. This phone's clock was two days ahead, so the date is in the future, and the server rejects the record. But it isn't thrown away. It stays on the phone, with the reason."

**1:48**
"So I change just the date and resubmit. The phone checks it again, then the server checks it again. It's the same record ID, so nothing gets duplicated, and this time it's accepted."

**1:59**
"There's no real satellite feed here, so I made an API that a national user can call to add the climate values. The analysis runs again, and now the phone's records show up in a new alert."

**2:10**
"On the dashboard, the national view shows alerts by LGA and month. The Analysis tab shows what R did: 222 rows flagged, 1,303 clean, and 647 alerts. That's the same as the reference."

**2:25**
"A field worker only sees their own records, and a state officer only sees their own state. That's enforced inside the database, not only in the API."

**2:35**
"163 automated tests pass, and the R results match the reference exactly. Now the limits. I tested on an emulator, not a real phone, the climate feed is a stub, and login is just a demo header. The README explains why I chose this backend, and it says I built this with Claude Code. Thank you."
