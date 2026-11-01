import sys, subprocess, json, numpy as np
f = sys.argv[1]
raw = subprocess.run(['ffmpeg','-loglevel','error','-i',f,'-ac','1','-ar','48000','-f','f32le','-'],capture_output=True).stdout
a = np.frombuffer(raw, dtype=np.float32)
win = 240  # 5 ms
env = np.sqrt(np.convolve(a*a, np.ones(win)/win, mode='same'))
thr = 0.04
above = env > thr
aon = [i/48000 for i in range(1,len(above)) if above[i] and not above[i-1]]
# video: per-frame mean luma with pts
out = subprocess.run(['ffprobe','-v','error','-f','lavfi','-i',f"movie={f},signalstats",'-show_entries','frame=pkt_pts_time,best_effort_timestamp_time:frame_tags=lavfi.signalstats.YAVG','-of','json'],capture_output=True,text=True).stdout
frames = json.loads(out)['frames']
ts = [(float(fr.get('best_effort_timestamp_time', fr.get('pkt_pts_time',0))), float(fr['tags']['lavfi.signalstats.YAVG'])) for fr in frames]
von = [ts[i][0] for i in range(1,len(ts)) if ts[i][1] - ts[i-1][1] > 40]
print('audio onsets', [round(x,3) for x in aon])
print('video onsets', [round(x,3) for x in von])
offs = []
for x in aon:
    if von:
        n = min(von, key=lambda v: abs(v-x)); offs.append(round(n - x, 3))
print('video-minus-audio offsets (s)', offs)
print('max |offset|', max(map(abs, offs)) if offs else None)
