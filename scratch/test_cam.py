import cv2
import time
import mediapipe as mp

print("Testing OpenCV VideoCapture...")
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
print("cap.isOpened():", cap.isOpened())
if cap.isOpened():
    ret, frame = cap.read()
    print("Read frame success:", ret)
    if ret:
        print("Frame shape:", frame.shape)
    cap.release()
print("OpenCV test complete.")

print("Testing MediaPipe initialization...")
mp_hands = mp.solutions.hands
hands = mp_hands.Hands()
print("MediaPipe Hands initialised.")
hands.close()

mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(refine_landmarks=True)
print("MediaPipe Face Mesh initialised.")
face_mesh.close()
print("All tests complete.")
