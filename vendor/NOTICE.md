# GazeTR-Hybrid

Source: https://github.com/yihuacheng/GazeTR
Authors: Yihua Cheng and Feng Lu, Gaze Estimation using Transformer, ICPR 2022.
Upstream license: CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/).
See README.upstream.md. These source files retain the upstream license.
Local modification: model.py creates positional indices on the input device instead of CUDA.
The ETH-XGaze pretrained checkpoint is downloaded from the link supplied by the authors.

Face normalization reference: https://github.com/xucong-zhang/ETH-XGaze/blob/master/demo.py
The six metric landmark coordinates in backend/tracker.py are from rows
[20, 23, 26, 29, 15, 19] of the official ETH-XGaze face_model.txt:
https://github.com/xucong-zhang/ETH-XGaze/blob/master/face_model.txt
These describe eye corners and nose corners; the virtual crop center weights their
two group centers equally. Pixel preprocessing still follows GazeTR's own reader.
