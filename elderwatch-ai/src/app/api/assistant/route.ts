import { NextResponse } from "next/server";
import type { ResidentProfile, SafetyClassification } from "@/lib/types";
import { RECOMMENDED_ACTIONS } from "@/lib/classifySafety";

// ─────────────────────────────────────────────────────────────────────────────
// AI Care Assistant Route
// Returns general (non-medical, non-diagnostic) guidance for caregivers.
// Uses Claude API if ANTHROPIC_API_KEY is set; otherwise returns realistic
// mock guidance grounded in the current event context.
//
// DISCLAIMER: Responses are general guidance only and do not constitute
// medical advice. Always follow your facility's protocols.
// ─────────────────────────────────────────────────────────────────────────────

interface AssistantRequest {
  question: string;
  resident: ResidentProfile;
  classification: SafetyClassification;
}

const BASE_RESPONSES: Record<string, string> = {
  possible_fall:
    "A possible fall was detected. Approach calmly and check if the resident is conscious and responsive. Do not move them if they report pain or injury is suspected. Clear the area of hazards and call for help if needed. Follow your facility's emergency protocol and notify medical staff promptly.",
  fall_risk:
    "The resident appears to be in a low or unstable position. Approach carefully, offer a steady hand, and help them return to a safe seated or standing posture. Ensure the floor is clear of obstacles and document the incident per your facility's protocol.",
  immobility:
    "The resident has had very little movement for an extended period. Check in gently to confirm they are comfortable and alert. Offer water and ask if they need assistance. If they appear unresponsive or unusually lethargic, escalate to your supervisor or medical staff immediately.",
  wandering:
    "The resident has moved outside their designated safe area. Approach calmly without startling them and gently redirect them back to their room or common area. Note the time and circumstances in the care log. Consider whether the resident's environment needs adjustment.",
  unsafe_posture:
    "The resident's posture appears unstable. Assist them to a comfortable, well-supported position. Ask if they feel dizzy or in pain. If they report any discomfort, do not force movement and request a clinical assessment.",
  seizure_like_motion:
    "Possible seizure-like movement was detected. Go to the resident immediately. Do NOT restrain them. Clear the area of hard objects and protect their head with something soft if possible. Time the episode. Call medical staff and follow your facility's seizure response protocol. Note: this system detects rapid movement patterns only — it does not diagnose seizures. Always rely on direct observation and medical assessment.",
  out_of_frame:
    "The resident is no longer visible on camera. Perform a manual check of the room and nearby areas. If they cannot be found within a few minutes, alert your supervisor per facility protocol.",
  audio_distress:
    "Verbal distress was detected via the audio monitor. Go to the resident immediately, speak calmly, and assess what they need. If they are in pain or injured, follow your facility's emergency protocol.",
  possible_distress_sound:
    "A possible distress sound was detected. Perform a check on the resident. Approach calmly and ask if they need assistance. If you observe anything concerning, escalate to your supervisor.",
  possible_fall_sound:
    "A possible fall impact sound was detected. Check on the resident's location and physical condition. If they have fallen, follow your facility's fall response protocol.",
  possible_choking:
    "Possible choking or breathing difficulty was detected. Go to the resident immediately. Ask if they can speak or breathe normally. If choking is confirmed, follow your facility's choking response protocol and call emergency services if needed. This system does not diagnose choking — always rely on direct observation.",
  normal:
    "No concerns are currently detected. Continue your routine monitoring. Use this time to review the event log and follow up on any previously acknowledged alerts.",
};

const EMERGENCY_RESPONSES: Record<string, string> = {
  possible_fall:
    "Yes, treat this as a potential emergency. If the resident is unresponsive or reports pain, do not move them and call emergency services immediately. Stay with them and keep them calm until help arrives.",
  fall_risk:
    "This is a high-priority alert. Reach the resident immediately, offer support, and prevent any further loss of balance. If the resident has fallen or complains of pain, follow your emergency protocol.",
  immobility:
    "Prolonged immobility can indicate a medical issue. If the resident is unresponsive or in distress, escalate immediately to medical staff — do not wait.",
  wandering:
    "Not typically an emergency, but locate the resident quickly. If they are near a hazardous area or seem confused, get additional staff to assist with a safe redirect.",
  unsafe_posture:
    "If the resident appears in pain, very unsteady, or unresponsive, treat this as urgent and request immediate clinical assessment.",
  seizure_like_motion:
    "Yes — treat this as an emergency. Call for medical staff immediately. Do not restrain the resident. Stay with them, protect their head, and time the episode. If this is a first seizure or lasts more than 5 minutes, call emergency services. Do not leave them alone.",
  out_of_frame:
    "Perform a manual check immediately. If the resident cannot be found within a few minutes, treat it as an emergency and follow your missing-resident protocol.",
  audio_distress:
    "Yes — treat this as urgent. Get to the resident immediately. If they are unresponsive, in pain, or unable to get up, call for help and follow your emergency protocol.",
  possible_distress_sound:
    "Treat this as a high-priority check. Reach the resident quickly and determine if they need help. If in doubt, escalate.",
  possible_fall_sound:
    "Investigate promptly. If the resident has fallen, follow your facility's fall response protocol. Do not attempt to move them if injury is suspected.",
  possible_choking:
    "Yes — treat this as urgent. Get to the resident immediately. If they cannot speak or breathe, call emergency services and follow your facility's choking response protocol. Do not leave them alone.",
  normal:
    "No active alerts at this time. If you personally observe something concerning, always trust your judgment and escalate as needed.",
};

const DOCUMENT_RESPONSES: Record<string, string> = {
  possible_fall:
    "Document: exact time of alert, resident's position when found, level of responsiveness, any pain reported, actions taken, and staff involved. Notify the nurse and complete an incident report per facility policy.",
  fall_risk:
    "Log the time, the detected posture, your intervention (e.g., assisted to chair), and any resident complaint. Note it in the shift handover as well.",
  immobility:
    "Record how long the resident was still, their condition when checked, fluids or comfort offered, and any escalation. Update the care log for the next shift.",
  wandering:
    "Note the time, where the resident was found, their apparent orientation (confused/calm), how they were redirected, and any changes in behaviour worth flagging.",
  unsafe_posture:
    "Document the time, observed posture angle or lean, any complaints of dizziness or pain, and the corrective action taken. If a clinical check was requested, note the outcome.",
  seizure_like_motion:
    "Document: exact time the alert fired, duration of any observed movement, the resident's condition before and after, actions taken, staff involved, and medical staff notified. Complete an incident report. If a seizure was confirmed, note whether it was a first occurrence or recurrence.",
  out_of_frame:
    "Log the time the resident went off-camera, when and where they were located, and any context for why they left the monitored area.",
  audio_distress:
    "Document: exact time of audio alert, transcript of detected speech if available, matched keywords, your response time, the resident's condition when checked, and any actions taken. Complete an incident report if the situation was serious.",
  possible_distress_sound:
    "Log the time, the audio event type detected, what you observed when you checked, and any resident complaint or explanation.",
  possible_fall_sound:
    "Record the time of the audio alert, what sound was detected, the resident's condition when checked, and any actions taken. If a fall occurred, complete an incident report.",
  possible_choking:
    "Document: exact time of alert, source (audio/vision), resident's condition when assessed, ability to speak or breathe, actions taken, and outcome. Complete an incident report. If emergency services were called, note the response time.",
  normal:
    "No specific incident to document. Review the event log for any unacknowledged alerts from the past shift and add notes where appropriate.",
};

const HELP_RESPONSES: Record<string, string> = {
  possible_fall:
    "Move quickly but calmly to the resident. Kneel or crouch to their level, speak reassuringly, and assess for injury before attempting any movement. If injured, keep them still and call for help.",
  fall_risk:
    "Approach from the front so the resident sees you. Offer both hands or a stable surface to hold, and guide them back to a safe position slowly. Ask how they feel before and after moving.",
  immobility:
    "Knock and enter quietly. Call the resident by name, check for a response, and observe their breathing and colour. Offer fluids and ask if they need assistance changing position.",
  wandering:
    "Use a calm, familiar tone. Do not block or grab them — walk alongside and gently guide them back. Distraction (e.g., mentioning a meal or activity) can help with redirecting.",
  unsafe_posture:
    "Approach from the front, introduce yourself, and ask permission before adjusting their position. Use a gait belt if needed and ensure their back is supported before leaving.",
  seizure_like_motion:
    "Go to the resident immediately. Do NOT restrain them — move hazardous objects away instead. If the resident is in a chair or bed, stay close to support them. When the movement stops, gently turn them on their side (recovery position), call for medical staff, and stay until help arrives.",
  out_of_frame:
    "Do a systematic check: bathroom, common areas, adjacent rooms. Bring a radio or phone so you can call for backup quickly if needed.",
  audio_distress:
    "Go to the resident immediately. Speak calmly and clearly. Ask what they need and listen carefully. If they are in pain or distress, do not leave them alone — call for help and stay until assistance arrives.",
  possible_distress_sound:
    "Knock and enter calmly. Call the resident by name and ask if they are okay. Check their condition and ask if they need anything. If something seems wrong, escalate.",
  possible_fall_sound:
    "Go to the resident. Check whether they have fallen or are on the floor. If so, stay with them, do not move them without assessing for injury, and call for backup.",
  possible_choking:
    "Go to the resident immediately. Ask: 'Are you choking? Can you breathe?' If they cannot breathe or speak, call emergency services and begin first aid per your training. If they are coughing forcefully, encourage them to continue and stay close.",
  normal:
    "No intervention required right now. A friendly check-in is always welcome — knock, say hello, and confirm the resident is comfortable.",
};

function getMockGuidance(eventType: string, question: string): string {
  const q = question.toLowerCase();

  if (q.includes("emergency") || q.includes("urgent") || q.includes("serious") || q.includes("dangerous")) {
    return EMERGENCY_RESPONSES[eventType] ?? BASE_RESPONSES[eventType] ?? "Follow your facility's emergency protocol and check on the resident immediately.";
  }

  if (q.includes("document") || q.includes("log") || q.includes("note") || q.includes("record") || q.includes("report")) {
    return DOCUMENT_RESPONSES[eventType] ?? BASE_RESPONSES[eventType] ?? "Document the time, observations, and actions taken in the care log.";
  }

  if (q.includes("help") || q.includes("assist") || q.includes("how do i") || q.includes("how should") || q.includes("what do i")) {
    return HELP_RESPONSES[eventType] ?? BASE_RESPONSES[eventType] ?? "Approach calmly and follow your facility's care protocol.";
  }

  return BASE_RESPONSES[eventType] ?? "Please follow your facility's standard care protocol and check on the resident directly.";
}

async function callClaudeAPI(
  question: string,
  resident: ResidentProfile,
  classification: SafetyClassification
): Promise<string> {
  const systemPrompt = `You are a helpful assistant for professional caregivers at an elderly care facility.
You provide general, practical guidance only — you do not diagnose conditions or replace medical professionals.
Always remind the caregiver to follow their facility's protocols.
Keep responses concise (2–4 sentences), calm, and actionable.
Never make specific medical claims or diagnoses.`;

  const userMessage = `Resident: ${resident.name}, age ${resident.age}, Room ${resident.room}
Mobility: ${resident.mobility}, Fall Risk: ${resident.fallRisk}
Conditions (general notes): ${resident.conditions.join(", ")}
Care notes: ${resident.careNotes}

Current alert: ${classification.severity.toUpperCase()} — ${classification.eventType} (${Math.round(classification.confidence * 100)}% confidence)
Reason: ${classification.reason}
Recommended action: ${RECOMMENDED_ACTIONS[classification.eventType] || "Follow facility protocol"}

Caregiver question: ${question}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API error: ${response.status}`);
  const data = await response.json();
  return data.content?.[0]?.text ?? "No guidance available at this time.";
}

export async function POST(req: Request) {
  try {
    const body: AssistantRequest = await req.json();
    const { question, resident, classification } = body;

    if (typeof question !== "string" || !question.trim() || !classification || typeof classification.eventType !== "string" || !resident) {
      return NextResponse.json({ error: "Missing question or classification" }, { status: 400 });
    }

    let guidance: string;
    let generatedBy = "mock";

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        guidance = await callClaudeAPI(question, resident, classification);
        generatedBy = "claude";
      } catch (apiErr) {
        console.warn("Claude API call failed, using mock:", apiErr);
        guidance = getMockGuidance(classification.eventType, question);
      }
    } else {
      guidance = getMockGuidance(classification.eventType, question);
    }

    return NextResponse.json({
      guidance,
      disclaimer:
        "This guidance is general information only and does not constitute medical advice. Always follow your facility's protocols and involve medical staff when appropriate.",
      generatedBy,
    });
  } catch (err) {
    console.error("POST /api/assistant error:", err);
    return NextResponse.json({ error: "Assistant unavailable" }, { status: 500 });
  }
}
