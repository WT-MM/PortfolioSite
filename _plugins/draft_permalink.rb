module Jekyll
  Hooks.register :posts, :pre_render do |post|
    tags = post.data['tags'] || []
    next unless tags.include?('draft')
    next if post.data['permalink']

    post.data['permalink'] = "/drafts/#{post.slug}/"
  end
end
