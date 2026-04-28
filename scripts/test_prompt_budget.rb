#!/usr/bin/env ruby
require 'yaml'
require 'json'
require 'time'

TASK_ID = ARGV[0]
AGENT = ARGV[1]
RUNNER = ARGV[2] || 'cursor'
ROOT = File.expand_path(File.join(__dir__, '..'))
OFFICE = File.join(ROOT, 'office.config.yaml')
RUNS_DIR = File.join(ROOT, 'runs')
TASK_DIR = File.join(RUNS_DIR, TASK_ID)
AGENTS_DIR = File.join(ROOT, 'agents')

unless TASK_ID && AGENT
  puts "Usage: ruby scripts/test_prompt_budget.rb <TASK_ID> <AGENT> [RUNNER]"
  exit 1
end

config = YAML.load_file(OFFICE)

prompt_budget = config.dig('prompt_budget') || {}
prompt_enabled = prompt_budget['enabled'] || false
chars_per_token = prompt_budget.dig('estimate','chars_per_token') || 4

def previous_agents_for(agent)
  case agent
  when 'reviewer'
    %w[dev dev-2 debugger devops free-roam]
  when 'debugger'
    %w[reviewer]
  when 'devops'
    %w[reviewer free-roam]
  when 'dev', 'dev-2'
    %w[pm debugger free-roam devops]
  when 'free-roam'
    %w[reviewer debugger devops pm dev dev-2]
  when 'pm'
    []
  else
    %w[pm reviewer debugger devops dev dev-2 free-roam]
  end
end

# load files
agent_prompt_file = File.join(AGENTS_DIR, "#{AGENT}.md")
pm = File.join(TASK_DIR, 'pm-output.yaml')
task_file = File.join(TASK_DIR, 'task.md')
status_file = File.join(TASK_DIR, 'status.yaml')

agent_prompt = File.exist?(agent_prompt_file) ? File.read(agent_prompt_file) : ""
pm_section = File.exist?(npm) ? "--- PM OUTPUT ---\n" + File.read(npm) : ""
task_section = File.exist?(task_file) ? "--- TASK ---\n" + File.read(task_file) : ""
status_section = File.exist?(status_file) ? "--- STATUS ---\n" + File.read(status_file) : ""

# Determine previous output
prev_output = nil
preferred = previous_agents_for(AGENT)

history_agents = []
if File.exist?(status_file)
  status = YAML.load_file(status_file) || {}
  history = Array(status['history'])
  history_agents = history.reverse.map { |e| e.is_a?(Hash) ? e['agent'].to_s : nil }.compact
end

# find latest present preferred
preferred.each do |p|
  if history_agents.include?(p)
    path = File.join(TASK_DIR, "#{p}-output.yaml")
    if File.exist?(path)
      prev_output = path
      break
    end
  end
end

# fallback: first existing preferred
if prev_output.nil?
  preferred.each do |p|
    path = File.join(TASK_DIR, "#{p}-output.yaml")
    if File.exist?(path)
      prev_output = path
      break
    end
  end
end

# reviewer include_all override
reviewer_include_all = false
if prompt_enabled && prompt_budget['agents'] && prompt_budget['agents']['reviewer']
  reviewer_include_all = !!prompt_budget['agents']['reviewer']['include_all_dev_outputs']
end

all_dev_outputs = ""
if AGENT == 'reviewer' && reviewer_include_all
  %w[dev dev-2 debugger devops free-roam].each do |p|
    path = File.join(TASK_DIR, "#{p}-output.yaml")
    if File.exist?(path)
      all_dev_outputs += "--- DEV OUTPUT (#{p}) ---\n"
      all_dev_outputs += File.read(path)
    end
  end
end

prev_section = ""
if AGENT == 'reviewer'
  if reviewer_include_all && !all_dev_outputs.empty?
    prev_section = all_dev_outputs
  elsif prev_output && File.basename(prev_output) != 'pm-output.yaml'
    prev_agent = File.basename(prev_output).sub('-output.yaml','')
    prev_section = "--- PREVIOUS AGENT OUTPUT (#{prev_agent}) ---\n" + File.read(prev_output)
  end
else
  if prev_output && File.basename(prev_output) != 'pm-output.yaml'
    prev_agent = File.basename(prev_output).sub('-output.yaml','')
    prev_section = "--- PREVIOUS AGENT OUTPUT (#{prev_agent}) ---\n" + File.read(prev_output)
  end
end

prompt = agent_prompt + "\n" + task_section + status_section + pm_section + prev_section + "\n\nProduce your output following the Output Contract in your role definition."

prompt_bytes = prompt.bytesize
estimated_tokens = (prompt_bytes.to_f / chars_per_token).ceil

puts "PROMPT_BYTES=#{prompt_bytes}"
puts "ESTIMATED_TOKENS=#{estimated_tokens} (chars_per_token=#{chars_per_token})"
puts "PROMPT_SOURCES:"
sources = []
sources << "agents/#{AGENT}.md"
sources << "runs/#{TASK_ID}/task.md" if File.exist?(task_file)
sources << "runs/#{TASK_ID}/status.yaml" if File.exist?(status_file)
sources << "runs/#{TASK_ID}/pm-output.yaml" if File.exist?(npm)
if AGENT == 'reviewer'
  if reviewer_include_all
    %w[dev dev-2 debugger devops free-roam].each do |p|
      sources << "runs/#{TASK_ID}/#{p}-output.yaml" if File.exist?(File.join(TASK_DIR, "#{p}-output.yaml"))
    end
  else
    sources << "runs/#{TASK_ID}/#{File.basename(prev_output)}" if prev_output
  end
else
  sources << "runs/#{TASK_ID}/#{File.basename(prev_output)}" if prev_output
end
puts sources.join(', ')

# append meta event
meta_file = File.join(TASK_DIR, 'meta.yaml')
meta = File.exist?(meta_file) ? YAML.load_file(meta_file) || {} : {}
meta['task_id'] ||= TASK_ID
meta['events'] ||= []
meta['events'] << {
  'type' => 'prompt_budget',
  'agent' => AGENT,
  'details' => {
    'source_bytes' => prompt_bytes,
    'estimated_prompt_tokens' => estimated_tokens,
    'max_source_bytes' => (prompt_budget.dig('agents', AGENT, 'max_source_bytes') || prompt_budget.dig('defaults','max_source_bytes') || 18000),
    'prompt_sources' => sources,
    'runner' => RUNNER
  },
  'timestamp' => Time.now.utc.iso8601
}
meta['updated_at'] = Time.now.utc.iso8601
File.write(meta_file, YAML.dump(meta))
puts "Wrote prompt_budget event to #{meta_file}"

# write assembled prompt to file for inspection
File.write(File.join(TASK_DIR, '.assembled-prompt.txt'), prompt)
puts "Assembled prompt saved to runs/#{TASK_ID}/.assembled-prompt.txt"
