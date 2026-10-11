// A known-good implementation of the frozen interface, written by hand. It is not part of a run:
// it shows that the contract can be met, and it is the baseline to compare the models' output with.
#include "AbilitySystem.h"

#include <algorithm>

namespace lc {

AbilitySystem::AbilitySystem(AttributeSet attributes) : attributes_(attributes) {}

void AbilitySystem::Grant(const AbilitySpec& spec) {
  abilities_[spec.id] = spec;
  readyAt_.erase(spec.id);
}

bool AbilitySystem::HasAbility(const std::string& id) const { return abilities_.count(id) > 0; }

ActivationResult AbilitySystem::TryActivate(const std::string& id, AbilitySystem& target, double now) {
  const auto found = abilities_.find(id);
  if (found == abilities_.end()) return ActivationResult::UnknownAbility;
  const AbilitySpec& spec = found->second;
  if (CooldownRemaining(id, now) > 0.0) return ActivationResult::OnCooldown;
  for (const Tag& tag : spec.blockedBy) {
    if (HasTag(tag)) return ActivationResult::Blocked;
  }
  if (attributes_.mana < spec.manaCost) return ActivationResult::NotEnoughMana;
  if (target.Attributes().health <= 0.0f) return ActivationResult::TargetDead;
  attributes_.mana -= spec.manaCost;
  readyAt_[id] = now + spec.cooldownSeconds;
  if (spec.damage != 0.0f) target.ApplyDamage(spec.damage);
  return ActivationResult::Activated;
}

double AbilitySystem::CooldownRemaining(const std::string& id, double now) const {
  const auto ready = readyAt_.find(id);
  return ready == readyAt_.end() ? 0.0 : std::max(0.0, ready->second - now);
}

void AbilitySystem::AddTag(const Tag& tag) { tags_.insert(tag); }
void AbilitySystem::RemoveTag(const Tag& tag) { tags_.erase(tag); }
bool AbilitySystem::HasTag(const Tag& tag) const { return tags_.count(tag) > 0; }

void AbilitySystem::ApplyDamage(float amount) {
  attributes_.health = std::clamp(attributes_.health - amount, 0.0f, attributes_.maxHealth);
}

void AbilitySystem::RestoreMana(float amount) {
  attributes_.mana = std::clamp(attributes_.mana + amount, 0.0f, attributes_.maxMana);
}

const AttributeSet& AbilitySystem::Attributes() const { return attributes_; }

}  // namespace lc
