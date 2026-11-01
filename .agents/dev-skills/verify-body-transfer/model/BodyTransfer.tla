---- MODULE BodyTransfer ----
\* ADR 0286's self record across three bodies: one self, at most one active body.
\* Each action is one serial() critical section of BodyTransfer in
\* apps/clankie/src/body-transfer.ts (or boot()), which ends in one self.json write.
EXTENDS Naturals, FiniteSets
CONSTANTS Bodies, Ids, Home,
          Bound,             \* steps held to the body named at freeze: a subset of {"stage", "release", "abort"}
          AllowReclaim,      \* reclaim --force is the owner's documented escape (ADR 0286)
          Broken,            \* "none", or a deliberately broken guard to prove the check can fail
          MaxEpoch
VARIABLES has, st, epoch, tid, rec, recEpoch, peer
vars == <<has, st, epoch, tid, rec, recEpoch, peer>>

None == "none"
SourceOutcomes == {"frozen", "released", "aborted"}
DestOutcomes == {"staged", "applying", "applied", "burned"}

\* has[b]: self.json names this Clankie's selfId. A body with no record reads as
\* active with epoch 0 (current()), but it is a fresh, empty install, not this self.
Init == /\ has = [b \in Bodies |-> b = Home]
        /\ st = [b \in Bodies |-> "active"]
        /\ epoch = [b \in Bodies |-> 0]
        /\ tid = [b \in Bodies |-> None]
        /\ rec = [b \in Bodies |-> [t \in Ids |-> None]]
        /\ recEpoch = [b \in Bodies |-> [t \in Ids |-> 0]]
        /\ peer = [b \in Bodies |-> [t \in Ids |-> None]]

\* freeze(): active source, unused id -> frozen at epoch+1, records the destination label.
Freeze(s, t, d) ==
  /\ s # d /\ has[s] /\ st[s] = "active" /\ rec[s][t] = None /\ epoch[s] < MaxEpoch
  /\ epoch' = [epoch EXCEPT ![s] = @ + 1]
  /\ st' = [st EXCEPT ![s] = "frozen"] /\ tid' = [tid EXCEPT ![s] = t]
  /\ rec' = [rec EXCEPT ![s][t] = "frozen"] /\ recEpoch' = [recEpoch EXCEPT ![s][t] = epoch[s] + 1]
  /\ peer' = [peer EXCEPT ![s][t] = d]
  /\ UNCHANGED has

\* exportBundle() at a frozen source, then stage()/stageStream()/admit() at d.
Stage(s, t, d) ==
  /\ s # d /\ st[s] = "frozen" /\ tid[s] = t /\ rec[s][t] = "frozen"
  /\ "stage" \in Bound => d = peer[s][t]
  /\ rec[d][t] = None
  /\ IF has[d]
       THEN st[d] # "active" /\ recEpoch[s][t] > epoch[d]       \* self_already_active_here, stale_epoch
       ELSE TRUE                                                \* fresh body: no selfId, no history
  /\ rec' = [rec EXCEPT ![d][t] = "staged"] /\ recEpoch' = [recEpoch EXCEPT ![d][t] = recEpoch[s][t]]
  /\ UNCHANGED <<has, st, epoch, tid, peer>>

\* apply(): staged -> frozen/applying (through cutover if it was active).
Apply(d, t) ==
  /\ rec[d][t] = "staged"
  /\ has' = [has EXCEPT ![d] = TRUE] /\ st' = [st EXCEPT ![d] = "frozen"] /\ tid' = [tid EXCEPT ![d] = t]
  /\ rec' = [rec EXCEPT ![d][t] = "applying"]
  /\ UNCHANGED <<epoch, recEpoch, peer>>

\* boot() -> applyStaged(): frozen/applying -> active at the manifest's epoch.
Boot(d) ==
  /\ st[d] = "frozen" /\ tid[d] # None /\ rec[d][tid[d]] = "applying"
  /\ st' = [st EXCEPT ![d] = "active"] /\ epoch' = [epoch EXCEPT ![d] = recEpoch[d][tid[d]]]
  /\ rec' = [rec EXCEPT ![d][tid[d]] = "applied"]
  /\ UNCHANGED <<has, tid, recEpoch, peer>>

\* release(): frozen source checks the activation it is handed (here: d's current authority).
Release(s, t, d) ==
  /\ s # d /\ st[s] = "frozen" /\ tid[s] = t /\ rec[s][t] = "frozen"
  /\ "release" \in Bound => d = peer[s][t]
  /\ (Broken # "release-unchecked") =>
        (has[d] /\ st[d] = "active" /\ epoch[d] = epoch[s] /\ tid[d] = t)
  /\ st' = [st EXCEPT ![s] = "released"] /\ rec' = [rec EXCEPT ![s][t] = "released"]
  /\ UNCHANGED <<has, epoch, tid, recEpoch, peer>>

\* discard(): burn an id that was never applied here.
Discard(d, t) ==
  /\ rec[d][t] \notin (CASE Broken = "discard-while-applying" -> {}
                         [] Broken = "discard-applying-only" -> {"applied"}
                         [] OTHER -> {"applying", "applied"})
  /\ rec[d][t] \notin SourceOutcomes
  /\ rec[d][t] # "burned"
  /\ rec' = [rec EXCEPT ![d][t] = "burned"]
  /\ recEpoch' = [recEpoch EXCEPT ![d][t] = IF recEpoch[d][t] = 0 THEN 1 ELSE @]
  /\ UNCHANGED <<has, st, epoch, tid, peer>>

\* abort(): frozen source returns to active when the body it is shown burned the id.
Abort(s, t, d) ==
  /\ s # d /\ st[s] = "frozen" /\ tid[s] = t /\ rec[s][t] = "frozen"
  /\ "abort" \in Bound => d = peer[s][t]
  /\ rec[d][t] = "burned"
  /\ st' = [st EXCEPT ![s] = "active"] /\ rec' = [rec EXCEPT ![s][t] = "aborted"]
  /\ UNCHANGED <<has, epoch, tid, recEpoch, peer>>

\* reclaim(): the owner's forced escape from a dormant body.
Reclaim(b) ==
  /\ AllowReclaim /\ has[b] /\ st[b] # "active" /\ epoch[b] < MaxEpoch
  /\ st' = [st EXCEPT ![b] = "active"] /\ epoch' = [epoch EXCEPT ![b] = @ + 1]
  /\ UNCHANGED <<has, tid, rec, recEpoch, peer>>

Next == \/ \E s, d \in Bodies, t \in Ids : Freeze(s, t, d) \/ Stage(s, t, d) \/ Release(s, t, d) \/ Abort(s, t, d)
        \/ \E d \in Bodies, t \in Ids : Apply(d, t) \/ Discard(d, t)
        \/ \E b \in Bodies : Boot(b) \/ Reclaim(b)

\* One self, one active body (ADR 0286).
OneActiveSelf == Cardinality({b \in Bodies : has[b] /\ st[b] = "active"}) <= 1
\* Clankie is never lost: some body holds him, active or in transit.
NeverLost == \E b \in Bodies : has[b] /\ st[b] \in {"active", "frozen"}
====
