---- MODULE Participant ----
EXTENDS Naturals
VARIABLES phase, sessions, turns, current, permission, effect, published, effectPermission
vars == <<phase, sessions, turns, current, permission, effect, published, effectPermission>>
Init == /\ phase = "absent" /\ sessions = 0 /\ turns = 0
        /\ current = TRUE /\ permission = "none" /\ effect = FALSE /\ published = FALSE /\ effectPermission = "none"
Message == /\ phase = "absent" /\ current /\ sessions' = 1 /\ phase' = "starting"
           /\ UNCHANGED <<turns, current, permission, effect, published, effectPermission>>
Connect == /\ phase = "starting" /\ current /\ phase' = "ready"
           /\ UNCHANGED <<sessions, turns, current, permission, effect, published, effectPermission>>
LostLaunchResponse == /\ phase = "starting" /\ phase' = "uncertain"
                      /\ UNCHANGED <<sessions, turns, current, permission, effect, published, effectPermission>>
InspectOriginal == /\ phase = "uncertain" /\ current /\ phase' = "ready"
                   /\ UNCHANGED <<sessions, turns, current, permission, effect, published, effectPermission>>
Dispatch == /\ phase = "ready" /\ current /\ turns < 2 /\ phase' = "answering" /\ turns' = turns + 1
            /\ published' = FALSE /\ permission' = "none" /\ effect' = FALSE /\ effectPermission' = "none"
            /\ UNCHANGED <<sessions, current>>
RequestCommand == /\ phase = "answering" /\ current /\ phase' = "approval"
                  /\ UNCHANGED <<sessions, turns, current, permission, effect, published, effectPermission>>
OwnerApproves == /\ phase = "approval" /\ current /\ permission' = "owner" /\ phase' = "answering"
                 /\ UNCHANGED <<sessions, turns, current, effect, published, effectPermission>>
OwnerDeclines == /\ phase = "approval" /\ phase' = "answering" /\ permission' = "declined"
                 /\ UNCHANGED <<sessions, turns, current, effect, published, effectPermission>>
MachineWork == /\ phase = "answering" /\ current /\ permission = "owner" /\ effect' = TRUE /\ effectPermission' = permission
               /\ UNCHANGED <<phase, sessions, turns, current, permission, published>>
Reply == /\ phase = "answering" /\ current /\ phase' = "replied" /\ published' = TRUE
         /\ UNCHANGED <<sessions, turns, current, permission, effect, effectPermission>>
NextMessage == /\ phase = "replied" /\ current /\ turns < 2 /\ phase' = "ready"
               /\ published' = FALSE /\ UNCHANGED <<sessions, turns, current, permission, effect, effectPermission>>
Revoke == /\ current /\ current' = FALSE /\ published' = FALSE /\ phase' = "withheld"
          /\ UNCHANGED <<sessions, turns, permission, effect, effectPermission>>
Done == /\ ((phase = "replied" /\ turns = 2) \/ phase = "withheld") /\ UNCHANGED vars
Next == Message \/ Connect \/ LostLaunchResponse \/ InspectOriginal \/ Dispatch
        \/ RequestCommand \/ OwnerApproves \/ OwnerDeclines \/ MachineWork \/ Reply \/ NextMessage \/ Revoke \/ Done
Spec == Init /\ [][Next]_vars
NoDuplicateCharacter == sessions <= 1
ReuseCharacter == turns > 0 => sessions = 1
OnlyOwnerApprovesWork == effect => effectPermission = "owner"
NoReplyAfterRevocation == published => current
====
